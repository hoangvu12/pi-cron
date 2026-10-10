/**
 * The scheduler core: a periodic check that fires due tasks.
 *
 * Lifecycle: start() flips on a (unref'd) interval; each tick refreshes the
 * scheduler lock, reloads the durable store if it changed on disk, and runs
 * check(), which returns the fire events for that instant. stop() tears the
 * interval down and releases the lock. check() takes the current time as an
 * argument so the whole decision path is testable without real timers.
 *
 * Fire-time jitter:
 * - recurring tasks may fire up to 10% of their period late (max 15 min);
 * - one-shot tasks pinned to :00 or :30 may fire up to 90 s EARLY.
 * Offsets are derived deterministically from the task id, so they are stable
 * across restarts, and they spread load away from the minute marks everyone
 * lands on. Set PI_CRON_DISABLE_JITTER=1 to remove them.
 *
 * Jitter never makes a one-shot fire late, and the catch-up grace window is
 * larger than the maximum early jitter, so a task is only reported as
 * "missed while Pi was closed" when it is genuinely overdue.
 */

import { nextCronRunMs, parseCronExpression, type ParsedCron } from "./cron.ts";
import { SchedulerLock } from "./lock.ts";
import { type CronTask, DurableStore, TaskStore } from "./tasks.ts";

export const DEFAULT_TICK_MS = 1_000;

export interface FireEvent {
	task: CronTask;
	/** Epoch ms recorded as the fire time (becomes lastFiredAt for recurring tasks). */
	firedAt: number;
	kind: "recurring" | "oneShot" | "final";
	/** Next due time after this fire for recurring tasks; null otherwise. */
	nextRunAt: number | null;
}

export interface MissedEvent {
	task: CronTask;
	/** The scheduled occurrence that passed while no session was running. */
	scheduledFor: number;
}

export const ONE_SHOT_EARLY_JITTER_MS = 90_000;
export const RECURRING_MAX_JITTER_MS = 15 * 60_000;
export const RECURRING_JITTER_FRACTION = 0.1;
/** Overdue margin before a one-shot counts as missed rather than late. */
export const CATCH_UP_GRACE_MS = 2 * 60_000;
const DEFAULT_LOCK_REFRESH_TICKS = 5;

/** FNV-1a — stable small hash used for deterministic jitter offsets. */
function hash32(input: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function recurringJitterMs(task: CronTask, parsed: ParsedCron, anchor: number): number {
	const m1 = nextCronRunMs(parsed, anchor);
	if (m1 === null) return 0;
	const m2 = nextCronRunMs(parsed, m1);
	if (m2 === null) return 0;
	const period = m2 - m1;
	if (period <= 0) return 0;
	const maxLate = Math.min(Math.floor(period * RECURRING_JITTER_FRACTION), RECURRING_MAX_JITTER_MS);
	if (maxLate <= 0) return 0;
	return hash32(task.id) % (maxLate + 1);
}

export function oneShotEarlyJitterMs(task: CronTask, scheduledFor: number): number {
	const minute = new Date(scheduledFor).getMinutes();
	if (minute !== 0 && minute !== 30) return 0;
	return hash32(task.id) % (ONE_SHOT_EARLY_JITTER_MS + 1);
}

/**
 * The jittered instant at which the scheduler should fire this task.
 * For recurring tasks the anchor is the last fire (or creation); a due time
 * in the past means "fire on the next tick" — one fire per missed stretch,
 * never one per missed occurrence.
 */
export function dueAt(task: CronTask, nowMs: number, jitter = true): number | null {
	const parsed = parseCronExpression(task.cron);
	if (!parsed) return null;
	if (task.recurring) {
		const anchor = task.lastFiredAt ?? task.createdAt;
		const match = nextCronRunMs(parsed, anchor);
		if (match === null) return null;
		return match + (jitter ? recurringJitterMs(task, parsed, anchor) : 0);
	}
	const match = nextCronRunMs(parsed, task.createdAt);
	if (match === null) return null;
	return match - (jitter ? oneShotEarlyJitterMs(task, match) : 0);
}

/** Next upcoming occurrence from now — for listings and confirmations. */
export function nextRunForDisplay(task: CronTask, nowMs: number): number | null {
	const parsed = parseCronExpression(task.cron);
	if (!parsed) return null;
	return nextCronRunMs(parsed, nowMs);
}

export interface SchedulerOptions {
	sessionTasks: TaskStore;
	durable: DurableStore;
	lock: SchedulerLock;
	/** Unique per-process owner id written into the lock. */
	owner: string;
	pid?: number;
	/** Delivered once per fire; must not throw (failures are reported via onError). */
	onFire: (event: FireEvent) => void;
	onError?: (error: unknown, phase: "tick" | "fire") => void;
	/** Max age for recurring tasks before their next fire becomes final. 0 = never. */
	maxAgeMs?: number;
	tickMs?: number;
	jitter?: boolean;
	/** Lock heartbeat/refresh cadence, in ticks. */
	lockRefreshTicks?: number;
	now?: () => number;
}

export class CronScheduler {
	private readonly sessionTasks: TaskStore;
	private readonly durable: DurableStore;
	private readonly lock: SchedulerLock;
	private readonly owner: string;
	private readonly pid: number;
	private readonly onFire: (event: FireEvent) => void;
	private readonly onError?: (error: unknown, phase: "tick" | "fire") => void;
	private readonly maxAgeMs: number;
	private readonly tickMs: number;
	private readonly jitter: boolean;
	private readonly lockRefreshTicks: number;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private tickCount = 0;

	constructor(options: SchedulerOptions) {
		this.sessionTasks = options.sessionTasks;
		this.durable = options.durable;
		this.lock = options.lock;
		this.owner = options.owner;
		this.pid = options.pid ?? process.pid;
		this.onFire = options.onFire;
		this.onError = options.onError;
		this.maxAgeMs = options.maxAgeMs ?? 0;
		this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
		this.jitter = options.jitter ?? true;
		this.lockRefreshTicks = options.lockRefreshTicks ?? DEFAULT_LOCK_REFRESH_TICKS;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (this.timer) return;
		this.lock.tryAcquire(this.owner, this.pid, this.now());
		this.tickCount = 0;
		// unref: the scheduler must never keep the process alive on exit.
		this.timer = setInterval(() => this.tick(), this.tickMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.lock.release(this.owner);
	}

	private tick(): void {
		this.tickCount++;
		const nowMs = this.now();
		try {
			if (this.tickCount % this.lockRefreshTicks === 1) {
				if (this.lock.owns(this.owner)) {
					this.lock.refresh(this.owner, nowMs);
				} else {
					// Take over when the owning session crashed.
					this.lock.tryAcquire(this.owner, this.pid, nowMs);
				}
			}
			const events = this.check(nowMs);
			for (const event of events) {
				try {
					this.onFire(event);
				} catch (error) {
					this.onError?.(error, "fire");
				}
			}
		} catch (error) {
			this.onError?.(error, "tick");
		}
	}

	/**
	 * Evaluate all tasks for `nowMs` and mutate the stores for fires.
	 * Returns the events; the caller decides how to deliver them.
	 * Session-only tasks always evaluate here. Durable tasks evaluate only
	 * when this session owns the scheduler lock.
	 */
	check(nowMs: number): FireEvent[] {
		const events: FireEvent[] = [];
		for (const task of this.sessionTasks.list()) {
			this.evaluate(task, nowMs, events, false);
		}
		if (this.lock.owns(this.owner)) {
			for (const task of this.durable.maybeReload()) {
				this.evaluate(task, nowMs, events, true);
			}
		}
		return events;
	}

	private evaluate(task: CronTask, nowMs: number, events: FireEvent[], durable: boolean): void {
		const due = dueAt(task, nowMs, this.jitter);
		if (due === null || nowMs < due) return;

		const expired =
			task.recurring && this.maxAgeMs > 0 && nowMs - task.createdAt >= this.maxAgeMs;

		if (expired || !task.recurring) {
			// One-shot, or the final fire of an expired recurring task.
			if (durable) this.durable.remove(task.id);
			else this.sessionTasks.remove(task.id);
			events.push({ task, firedAt: nowMs, kind: task.recurring ? "final" : "oneShot", nextRunAt: null });
			return;
		}

		const updated: CronTask = { ...task, lastFiredAt: nowMs };
		if (durable) this.durable.upsert(updated);
		else this.sessionTasks.update(updated);
		events.push({
			task: updated,
			firedAt: nowMs,
			kind: "recurring",
			nextRunAt: nextRunForDisplay(updated, nowMs),
		});
	}

	/**
	 * One-shot durable tasks whose scheduled time passed while no session was
	 * running. They are removed and reported so the next session can decide
	 * whether to recreate them; recurring tasks simply resume at their next
	 * match. Only the lock owner performs catch-up.
	 */
	catchUpMissed(nowMs: number): MissedEvent[] {
		if (!this.lock.tryAcquire(this.owner, this.pid, nowMs)) return [];
		const missed: MissedEvent[] = [];
		for (const task of this.durable.read()) {
			if (task.recurring) continue;
			const parsed = parseCronExpression(task.cron);
			if (!parsed) continue;
			const scheduledFor = nextCronRunMs(parsed, task.createdAt);
			if (scheduledFor !== null && scheduledFor + CATCH_UP_GRACE_MS < nowMs) {
				missed.push({ task, scheduledFor });
				this.durable.remove(task.id);
			}
		}
		return missed;
	}
}
