/**
 * Validation and store coordination for the Cron tools.
 *
 * The controller is the testable core behind the tool layer: it owns the
 * create/delete/list rules (expression validity, next-match-within-a-year,
 * job budget, store routing) without knowing anything about Pi.
 */

import { cronToHuman, formatLocalTime, formatRelative, nextCronRunMs, parseCronExpression } from "./cron.ts";
import { nextRunForDisplay } from "./scheduler.ts";
import { type CronTask, DurableStore, newTaskId, TaskStore } from "./tasks.ts";

export interface CreateInput {
	cron: string;
	prompt: string;
	recurring: boolean;
	durable: boolean;
	sessionId?: string;
}

export interface CreateResult {
	id: string;
	humanSchedule: string;
	recurring: boolean;
	durable: boolean;
	nextRunAt: number | null;
	nextRunText: string;
	note?: string;
}

export interface TaskSummary {
	id: string;
	cron: string;
	humanSchedule: string;
	promptPreview: string;
	recurring: boolean;
	durable: boolean;
	nextRunAt: number | null;
}

const PROMPT_PREVIEW_LEN = 80;

function promptPreview(prompt: string): string {
	const collapsed = prompt.replace(/\s+/g, " ").trim();
	return collapsed.length > PROMPT_PREVIEW_LEN ? `${collapsed.slice(0, PROMPT_PREVIEW_LEN)}...` : collapsed;
}

/** Note shown when a session-only task is created in a session that will exit immediately. */
export const HEADLESS_SESSION_ONLY_NOTE =
	"This run is headless and exits after the current prompt, so a session-only task will never fire. Create it with durable: true if it must run.";

export interface ControllerOptions {
	sessionTasks: TaskStore;
	/** Durable store factory keyed by working directory. */
	durableFor: (cwd: string) => DurableStore;
	maxJobs: number;
	now?: () => number;
}

export class CronController {
	private readonly sessionTasks: TaskStore;
	private readonly durableFor: (cwd: string) => DurableStore;
	private readonly maxJobs: number;
	private readonly now: () => number;

	constructor(options: ControllerOptions) {
		this.sessionTasks = options.sessionTasks;
		this.durableFor = options.durableFor;
		this.maxJobs = options.maxJobs;
		this.now = options.now ?? Date.now;
	}

	create(input: CreateInput, cwd: string, mode?: string): CreateResult {
		const cron = input.cron.trim();
		const parsed = parseCronExpression(cron);
		if (!parsed) {
			throw new Error(
				`Invalid cron expression '${input.cron}'. Expected 5 fields: minute hour day-of-month month day-of-week (e.g. "*/5 * * * *").`,
			);
		}
		const nowMs = this.now();
		if (nextCronRunMs(parsed, nowMs) === null) {
			throw new Error(
				`Cron expression '${input.cron}' does not match any calendar date in the next year.`,
			);
		}

		const durable = this.durableFor(cwd);
		const total = this.sessionTasks.size + durable.read().length;
		if (total >= this.maxJobs) {
			throw new Error(
				`Too many scheduled tasks (max ${this.maxJobs}). Delete one first with CronDelete.`,
			);
		}

		const task: CronTask = {
			id: newTaskId(),
			cron,
			prompt: input.prompt,
			recurring: input.recurring,
			durable: input.durable,
			createdAt: nowMs,
			sessionId: input.sessionId,
		};
		if (input.durable) {
			durable.upsert(task);
		} else {
			this.sessionTasks.add(task);
		}

		const nextRunAt = nextRunForDisplay(task, nowMs);
		const result: CreateResult = {
			id: task.id,
			humanSchedule: cronToHuman(cron),
			recurring: task.recurring,
			durable: task.durable,
			nextRunAt,
			nextRunText:
				nextRunAt === null
					? "no upcoming occurrence"
					: `${formatLocalTime(nextRunAt)} (${formatRelative(nextRunAt, nowMs)})`,
		};
		if (mode === "print" && !input.durable) {
			result.note = HEADLESS_SESSION_ONLY_NOTE;
		}
		return result;
	}

	remove(id: string, cwd: string): TaskSummary {
		const existing = this.sessionTasks.get(id);
		if (existing) {
			this.sessionTasks.remove(id);
			return this.summarize(existing);
		}
		const durable = this.durableFor(cwd);
		const task = durable.read().find((t) => t.id === id);
		if (task && durable.remove(id)) {
			return this.summarize(task);
		}
		throw new Error(`No scheduled task with id '${id}'.`);
	}

	list(cwd: string): TaskSummary[] {
		const durable = this.durableFor(cwd);
		const nowMs = this.now();
		const all = [...this.sessionTasks.list(), ...durable.read()];
		return all
			.map((task) => this.summarize(task, nowMs))
			.sort((a, b) => {
				const aDue = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
				const bDue = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
				return aDue - bDue || a.id.localeCompare(b.id);
			});
	}

	private summarize(task: CronTask, nowMs = this.now()): TaskSummary {
		return {
			id: task.id,
			cron: task.cron,
			humanSchedule: cronToHuman(task.cron),
			promptPreview: promptPreview(task.prompt),
			recurring: task.recurring,
			durable: task.durable,
			nextRunAt: nextRunForDisplay(task, nowMs),
		};
	}
}
