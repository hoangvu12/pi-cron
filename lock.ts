/**
 * Scheduler lock — exactly one live session fires durable tasks per project.
 *
 * The lock is a small JSON file next to the durable task store
 * (`.pi/cron.lock`) holding an owner id, pid, and heartbeat timestamp.
 * - A lock is stale when its heartbeat is older than LOCK_STALE_MS or its
 *   pid is no longer alive; a stale lock may be taken over.
 * - Non-owners simply skip firing durable tasks (session-only tasks still
 *   fire) and re-probe periodically, so a crashed owner is replaced within
 *   seconds.
 * - Acquisition is best-effort: two sessions racing to acquire converge on
 *   one owner because every write is verified by a read-back, and any
 *   residual disagreement self-heals on the next probe.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CRON_LOCK_FILE_NAME } from "./tasks.ts";

export const LOCK_STALE_MS = 30_000;

export interface LockContents {
	owner: string;
	pid: number;
	createdAt: number;
	heartbeatAt: number;
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class SchedulerLock {
	readonly lockPath: string;

	constructor(piDir: string) {
		this.lockPath = path.join(piDir, CRON_LOCK_FILE_NAME);
	}

	read(): LockContents | null {
		try {
			const raw = fs.readFileSync(this.lockPath, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown> | null;
			if (
				parsed &&
				typeof parsed.owner === "string" &&
				typeof parsed.pid === "number"
			) {
				return {
					owner: parsed.owner,
					pid: parsed.pid,
					createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
					heartbeatAt: typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : 0,
				};
			}
			return null;
		} catch {
			return null;
		}
	}

	isStale(contents: LockContents, now = Date.now()): boolean {
		if (contents.heartbeatAt <= 0) return true;
		if (now - contents.heartbeatAt > LOCK_STALE_MS) return true;
		return !isPidAlive(contents.pid);
	}

	/**
	 * Acquire the lock when it is free, stale, or already ours.
	 * Returns true when this owner holds it afterwards.
	 */
	tryAcquire(owner: string, pid = process.pid, now = Date.now()): boolean {
		const current = this.read();
		if (current && current.owner !== owner && !this.isStale(current, now)) {
			return false;
		}
		const createdAt = current && current.owner === owner ? current.createdAt : now;
		return this.write({ owner, pid, createdAt, heartbeatAt: now }, owner);
	}

	/** Confirm ownership and bump the heartbeat. */
	refresh(owner: string, now = Date.now()): boolean {
		const current = this.read();
		if (!current || current.owner !== owner) return false;
		return this.write({ ...current, heartbeatAt: now }, owner);
	}

	owns(owner: string): boolean {
		const current = this.read();
		return current !== null && current.owner === owner;
	}

	release(owner: string): void {
		const current = this.read();
		if (current && current.owner === owner) {
			try {
				fs.rmSync(this.lockPath, { force: true });
			} catch {
				// Best-effort: a leftover lock goes stale and is taken over.
			}
		}
	}

	/** Write atomically, then read back to confirm ownership survived races. */
	private write(contents: LockContents, owner: string): boolean {
		try {
			fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
			const tmp = `${this.lockPath}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify(contents, null, 2)}\n`);
			try {
				fs.renameSync(tmp, this.lockPath);
			} catch {
				fs.rmSync(this.lockPath, { force: true });
				fs.renameSync(tmp, this.lockPath);
			}
			const back = this.read();
			return back !== null && back.owner === owner;
		} catch {
			return false;
		}
	}
}
