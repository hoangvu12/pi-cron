/**
 * Task model and stores.
 *
 * A task lives in exactly one place:
 * - session-only tasks (the default) live in an in-memory TaskStore and die
 *   with the session;
 * - durable tasks live in `<project>/.pi/scheduled-tasks.json` and survive
 *   restarts. The file is written atomically and re-read when its mtime or
 *   size changes, so a task created by another session is picked up live.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PI_DIR_NAME = ".pi";
export const DURABLE_FILE_NAME = "scheduled-tasks.json";
export const CRON_LOCK_FILE_NAME = "cron.lock";

export interface CronTask {
	/** Stable identifier, shown to the model for CronDelete. */
	id: string;
	/** Raw 5-field cron expression, local time. */
	cron: string;
	/** The prompt delivered when the task fires. */
	prompt: string;
	/** true = fire on every match; false = fire once at the pinned match, then delete. */
	recurring: boolean;
	/** true = persisted to .pi/scheduled-tasks.json and survives restarts. */
	durable: boolean;
	/** Epoch ms when the task was created. Drives recurring expiry. */
	createdAt: number;
	/** Epoch ms of the last fire (recurring only). */
	lastFiredAt?: number;
	/** Creating session id, for diagnostics. */
	sessionId?: string;
}

export function newTaskId(): string {
	return `t${randomBytes(4).toString("hex")}`;
}

/** Tolerant single-task parser: drops malformed entries instead of failing the file. */
export function parseTask(raw: unknown): CronTask | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" && r.id.length > 0 ? r.id : null;
	const cron = typeof r.cron === "string" && r.cron.length > 0 ? r.cron : null;
	const prompt = typeof r.prompt === "string" && r.prompt.length > 0 ? r.prompt : null;
	if (!id || !cron || !prompt) return null;
	const task: CronTask = {
		id,
		cron,
		prompt,
		recurring: r.recurring === true,
		durable: r.durable === true,
		createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
	};
	if (typeof r.lastFiredAt === "number" && Number.isFinite(r.lastFiredAt)) task.lastFiredAt = r.lastFiredAt;
	if (typeof r.sessionId === "string") task.sessionId = r.sessionId;
	return task;
}

/** In-memory store for session-only tasks. */
export class TaskStore {
	private readonly tasks = new Map<string, CronTask>();

	add(task: CronTask): void {
		this.tasks.set(task.id, { ...task });
	}

	get(id: string): CronTask | undefined {
		const task = this.tasks.get(id);
		return task ? { ...task } : undefined;
	}

	update(task: CronTask): void {
		this.tasks.set(task.id, { ...task });
	}

	remove(id: string): boolean {
		return this.tasks.delete(id);
	}

	list(): CronTask[] {
		return [...this.tasks.values()]
			.map((t) => ({ ...t }))
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	get size(): number {
		return this.tasks.size;
	}
}

/**
 * Resolve the project-scoped `.pi` directory for a working directory.
 *
 * Walks up from `cwd` and uses the nearest existing `.pi` directory (so a
 * session started in a subdirectory shares the project's durable tasks, the
 * same way git finds its root). The user's home directory is never used as
 * a project root — `~/.pi` is the global agent config, not this project's
 * store. When no `.pi` exists yet, the cwd is the root.
 */
export function resolvePiDir(cwd: string): string {
	const home = os.homedir();
	let dir = path.resolve(cwd);
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (dir !== home && fs.existsSync(path.join(dir, PI_DIR_NAME))) {
			return path.join(dir, PI_DIR_NAME);
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.join(path.resolve(cwd), PI_DIR_NAME);
}

interface FileStat {
	mtimeMs: number;
	size: number;
}

/** JSON-file store for durable tasks. */
export class DurableStore {
	readonly filePath: string;
	private cachedTasks: CronTask[] = [];
	private cachedStat: FileStat | null = null;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	/** Fresh read. Missing file -> []; corrupt file -> last known good. */
	read(): CronTask[] {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.filePath);
		} catch {
			this.cachedTasks = [];
			this.cachedStat = null;
			return [];
		}
		try {
			const raw = fs.readFileSync(this.filePath, "utf-8");
			const parsed: unknown = JSON.parse(raw);
			const list = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown } | null)?.tasks;
			this.cachedTasks = Array.isArray(list) ? list.map(parseTask).filter((t): t is CronTask => t !== null) : [];
			this.cachedStat = { mtimeMs: stat.mtimeMs, size: stat.size };
		} catch {
			// Corrupt mid-write or unreadable: keep the last known good list.
		}
		return [...this.cachedTasks];
	}

	/**
	 * Re-read only when the file changed on disk (another session wrote it).
	 * Returns the current list either way.
	 */
	maybeReload(): CronTask[] {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.filePath);
		} catch {
			if (this.cachedStat !== null) {
				this.cachedTasks = [];
				this.cachedStat = null;
			}
			return [];
		}
		if (
			this.cachedStat !== null &&
			stat.mtimeMs === this.cachedStat.mtimeMs &&
			stat.size === this.cachedStat.size
		) {
			return [...this.cachedTasks];
		}
		return this.read();
	}

	/** Atomic write (temp file + rename) and cache refresh. */
	write(tasks: CronTask[]): void {
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(tasks, null, 2)}\n`);
		try {
			fs.renameSync(tmp, this.filePath);
		} catch {
			// Windows rename-over-existing should work via libuv; fall back
			// to remove+rename for exotic filesystems.
			fs.rmSync(this.filePath, { force: true });
			fs.renameSync(tmp, this.filePath);
		}
		this.read();
	}

	upsert(task: CronTask): void {
		const tasks = this.read().filter((t) => t.id !== task.id);
		tasks.push({ ...task, durable: true });
		this.write(tasks);
	}

	remove(id: string): boolean {
		const tasks = this.read();
		const next = tasks.filter((t) => t.id !== id);
		if (next.length === tasks.length) return false;
		this.write(next);
		return true;
	}
}
