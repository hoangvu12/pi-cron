import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CATCH_UP_GRACE_MS,
	CronScheduler,
	type FireEvent,
	dueAt,
	nextRunForDisplay,
	oneShotEarlyJitterMs,
	recurringJitterMs,
} from "../scheduler.ts";
import { parseCronExpression } from "../cron.ts";
import { SchedulerLock } from "../lock.ts";
import { DurableStore, newTaskId, TaskStore, type CronTask } from "../tasks.ts";

const T0 = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();

function makeScheduler(overrides: Partial<ConstructorParameters<typeof CronScheduler>[0]> = {}): {
	scheduler: CronScheduler;
	sessionTasks: TaskStore;
	durable: DurableStore;
	lock: SchedulerLock;
	events: FireEvent[];
	dir: string;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-sched-"));
	const sessionTasks = new TaskStore();
	const durable = new DurableStore(path.join(dir, "scheduled-tasks.json"));
	const lock = new SchedulerLock(dir);
	const events: FireEvent[] = [];
	const scheduler = new CronScheduler({
		sessionTasks,
		durable,
		lock,
		owner: "owner-a",
		onFire: (event) => events.push(event),
		...overrides,
	});
	return { scheduler, sessionTasks, durable, lock, events, dir };
}

function sessionTask(overrides: Partial<CronTask> = {}): CronTask {
	return {
		id: newTaskId(),
		cron: "* * * * *",
		prompt: "tick",
		recurring: true,
		durable: false,
		createdAt: T0,
		...overrides,
	};
}

test("recurring task fires once per occurrence and reschedules", () => {
	const { scheduler, sessionTasks } = makeScheduler({ jitter: false });
	const task = sessionTask();
	sessionTasks.add(task);

	// Not due yet at 10:00:30.
	assert.deepEqual(scheduler.check(T0 + 30_000), []);
	// Due at 10:01:00 (first minute after creation).
	const fired = scheduler.check(T0 + 60_000);
	assert.equal(fired.length, 1);
	assert.equal(fired[0]!.kind, "recurring");
	assert.equal(fired[0]!.nextRunAt, T0 + 120_000);

	// Same instant: no double fire.
	assert.deepEqual(scheduler.check(T0 + 60_000), []);
	// Next occurrence at 10:02.
	assert.equal(scheduler.check(T0 + 120_000).length, 1);
	assert.equal(sessionTasks.get(task.id)!.lastFiredAt, T0 + 120_000);
});

test("one-shot task fires once and is removed", () => {
	const { scheduler, sessionTasks } = makeScheduler({ jitter: false });
	sessionTasks.add(sessionTask({ recurring: false }));

	const fired = scheduler.check(T0 + 60_000);
	assert.equal(fired.length, 1);
	assert.equal(fired[0]!.kind, "oneShot");
	assert.equal(fired[0]!.nextRunAt, null);
	assert.equal(sessionTasks.size, 0);
	assert.deepEqual(scheduler.check(T0 + 120_000), []);
});

test("expired recurring task fires one final time and is deleted", () => {
	const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
	const { scheduler, sessionTasks } = makeScheduler({ jitter: false, maxAgeMs });
	// Created 31 days before the due time.
	sessionTasks.add(sessionTask({ createdAt: T0 - 31 * 24 * 60 * 60 * 1000 }));

	const fired = scheduler.check(T0 + 60_000);
	assert.equal(fired.length, 1);
	assert.equal(fired[0]!.kind, "final");
	assert.equal(sessionTasks.size, 0);
});

test("maxAgeMs 0 disables expiry", () => {
	const { scheduler, sessionTasks } = makeScheduler({ jitter: false, maxAgeMs: 0 });
	sessionTasks.add(sessionTask({ createdAt: T0 - 400 * 24 * 60 * 60 * 1000 }));

	const fired = scheduler.check(T0 + 60_000);
	assert.equal(fired.length, 1);
	assert.equal(fired[0]!.kind, "recurring");
	assert.equal(sessionTasks.size, 1);
});

test("durable tasks fire only from the lock owner", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-sched-"));
	const sessionTasks = new TaskStore();
	const durable = new DurableStore(path.join(dir, "scheduled-tasks.json"));
	const task: CronTask = {
		id: newTaskId(),
		cron: "* * * * *",
		prompt: "tick",
		recurring: true,
		durable: true,
		createdAt: T0,
	};
	durable.upsert(task);

	// Another session owns the lock.
	const otherLock = new SchedulerLock(dir);
	assert.equal(otherLock.tryAcquire("owner-other", process.pid, T0), true);

	const events: FireEvent[] = [];
	const scheduler = new CronScheduler({
		sessionTasks,
		durable,
		lock: new SchedulerLock(dir),
		owner: "owner-a",
		onFire: (event) => events.push(event),
		jitter: false,
	});
	assert.deepEqual(scheduler.check(T0 + 60_000), []);
	assert.equal(events.length, 0);

	// Session-only tasks still fire without the lock.
	sessionTasks.add(sessionTask({ recurring: false }));
	assert.equal(scheduler.check(T0 + 60_000).length, 1);
});

test("durable task written by another session is picked up live", () => {
	const { scheduler, durable, lock } = makeScheduler({ jitter: false });
	assert.equal(lock.tryAcquire("owner-a", process.pid, T0), true);

	const external = new DurableStore(durable.filePath);
	external.upsert({
		id: newTaskId(),
		cron: "* * * * *",
		prompt: "from another session",
		recurring: false,
		durable: true,
		createdAt: T0,
	});

	const fired = scheduler.check(T0 + 60_000);
	assert.equal(fired.length, 1);
	assert.equal(fired[0]!.task.prompt, "from another session");
	assert.deepEqual(durable.read(), []);
});

test("durable recurring fire persists lastFiredAt", () => {
	const { scheduler, durable, lock } = makeScheduler({ jitter: false });
	assert.equal(lock.tryAcquire("owner-a", process.pid, T0), true);
	const task: CronTask = {
		id: newTaskId(),
		cron: "* * * * *",
		prompt: "tick",
		recurring: true,
		durable: true,
		createdAt: T0,
	};
	durable.upsert(task);

	scheduler.check(T0 + 60_000);
	const stored = durable.read().find((t) => t.id === task.id);
	assert.equal(stored?.lastFiredAt, T0 + 60_000);
});

test("paused recurring task fires once on resume, not once per missed occurrence", () => {
	const { scheduler, sessionTasks } = makeScheduler({ jitter: false });
	// Last fired 3 hours ago; hourly task.
	sessionTasks.add(
		sessionTask({ cron: "0 * * * *", createdAt: T0 - 4 * 60 * 60 * 1000, lastFiredAt: T0 - 3 * 60 * 60 * 1000 }),
	);
	const fired = scheduler.check(T0);
	assert.equal(fired.length, 1);
	// No catch-up for the two further missed hours.
	assert.deepEqual(scheduler.check(T0 + 1), []);
});

test("dueAt includes deterministic recurring jitter", () => {
	const task = sessionTask({ cron: "0 * * * *", lastFiredAt: T0 });
	const parsed = parseCronExpression(task.cron)!;
	const a = recurringJitterMs(task, parsed, T0);
	const b = recurringJitterMs(task, parsed, T0);
	assert.equal(a, b); // stable across calls
	const period = 60 * 60 * 1000;
	assert.ok(a <= Math.floor(period * 0.1), "jitter within 10% of the period");
	assert.equal(dueAt(task, T0, false), T0 + period);
	assert.equal(dueAt(task, T0, true), T0 + period + a);
});

test("dueAt recurring jitter caps at 15 minutes", () => {
	const task = sessionTask({ cron: "0 0 1 1 *", lastFiredAt: T0 });
	const parsed = parseCronExpression(task.cron)!;
	// A yearly task has a huge period; jitter must cap at 15 min.
	assert.ok(recurringJitterMs(task, parsed, T0) <= 15 * 60_000);
});

test("one-shot jitter only applies on :00/:30 and only fires early", () => {
	const atNine = new Date(2026, 0, 15, 9, 0).getTime();
	// Pinned from an hour before, so the single occurrence is 09:00 today.
	const onTheHour: CronTask = {
		...sessionTask({ recurring: false }),
		cron: "0 9 * * *",
		createdAt: atNine - 60 * 60 * 1000,
	};
	const early = oneShotEarlyJitterMs(onTheHour, atNine);
	assert.ok(early <= 90_000);
	assert.equal(dueAt(onTheHour, atNine, true), atNine - early);
	assert.equal(dueAt(onTheHour, atNine, false), atNine);

	const atNineOhSeven = new Date(2026, 0, 15, 9, 7).getTime();
	const offMinute: CronTask = {
		...onTheHour,
		cron: "7 9 * * *",
		createdAt: atNineOhSeven - 60 * 60 * 1000,
	};
	assert.equal(oneShotEarlyJitterMs(offMinute, atNineOhSeven), 0);
	assert.equal(dueAt(offMinute, atNineOhSeven, true), atNineOhSeven);
});

test("catchUpMissed reports overdue one-shots and removes them", () => {
	const { scheduler, durable, lock } = makeScheduler();
	const now = T0 + 24 * 60 * 60 * 1000; // one day after T0
	assert.equal(lock.tryAcquire("owner-a", process.pid, now), true);
	const past: CronTask = {
		id: newTaskId(),
		cron: "0 8 * * *",
		prompt: "yesterday's reminder",
		recurring: false,
		durable: true,
		createdAt: T0 - 2 * 24 * 60 * 60 * 1000,
	};
	// Created a minute before `now`; its pinned 08:00 is tomorrow -> future.
	const future: CronTask = {
		id: newTaskId(),
		cron: "0 8 * * *",
		prompt: "tomorrow's reminder",
		recurring: false,
		durable: true,
		createdAt: now - 60_000,
	};
	const recurring: CronTask = {
		id: newTaskId(),
		cron: "0 8 * * *",
		prompt: "recurring",
		recurring: true,
		durable: true,
		createdAt: T0 - 2 * 24 * 60 * 60 * 1000,
	};
	durable.upsert(past);
	durable.upsert(future);
	durable.upsert(recurring);

	const missed = scheduler.catchUpMissed(now);
	assert.equal(missed.length, 1);
	assert.equal(missed[0]!.task.id, past.id);
	// "past" was scheduled for the day after its creation — before `now`.
	assert.ok(missed[0]!.scheduledFor + CATCH_UP_GRACE_MS < now);
	assert.equal(durable.read().length, 2);
	assert.ok(durable.read().some((t) => t.id === future.id));
	assert.ok(durable.read().some((t) => t.id === recurring.id));
});

test("catchUpMissed skips tasks still within the grace window", () => {
	const { scheduler, durable, lock } = makeScheduler();
	assert.equal(lock.tryAcquire("owner-a", process.pid, T0), true);
	// One-shot due at 08:00 today; it is now 08:01 — only 1 minute overdue.
	const task: CronTask = {
		id: newTaskId(),
		cron: "0 8 * * *",
		prompt: "just now",
		recurring: false,
		durable: true,
		createdAt: T0 - 60 * 60 * 1000,
	};
	durable.upsert(task);
	const due = new Date(T0).setHours(8, 0, 0, 0);
	const now = due + 60_000;
	const missed = scheduler.catchUpMissed(now);
	assert.equal(missed.length, 0);
	assert.equal(durable.read().length, 1);
});

test("catchUpMissed does nothing without lock ownership", () => {
	const { scheduler, durable, dir } = makeScheduler();
	const now = T0 + 24 * 60 * 60 * 1000;
	// Another session owns the lock with a fresh heartbeat.
	const otherLock = new SchedulerLock(dir);
	assert.equal(otherLock.tryAcquire("owner-other", process.pid, now - 1000), true);
	durable.upsert({
		id: newTaskId(),
		cron: "0 8 * * *",
		prompt: "missed",
		recurring: false,
		durable: true,
		createdAt: T0 - 2 * 24 * 60 * 60 * 1000,
	});
	assert.deepEqual(scheduler.catchUpMissed(now), []);
	assert.equal(durable.read().length, 1);
});

test("invalid cron task never fires", () => {
	const { scheduler, sessionTasks } = makeScheduler();
	sessionTasks.add(sessionTask({ cron: "not a cron" }));
	assert.equal(dueAt(sessionTask({ cron: "not a cron" }), T0), null);
	assert.deepEqual(scheduler.check(T0 + 60_000), []);
});

test("nextRunForDisplay looks forward from now", () => {
	const task = sessionTask({ cron: "0 * * * *", lastFiredAt: T0 });
	// Display ignores history: next occurrence after `now`.
	const now = T0 + 3 * 60 * 60 * 1000;
	assert.equal(nextRunForDisplay(task, now), T0 + 4 * 60 * 60 * 1000);
});

test("start/stop lifecycle acquires and releases the lock", () => {
	const { scheduler, lock, dir } = makeScheduler({ tickMs: 250 });
	scheduler.start();
	assert.equal(lock.owns("owner-a"), true);
	scheduler.stop();
	assert.equal(new SchedulerLock(dir).read(), null);
});

test("tick loop fires due tasks via onFire", async () => {
	const { scheduler, sessionTasks, events } = makeScheduler({
		tickMs: 5,
		jitter: false,
		now: () => T0 + 60_000,
	});
	sessionTasks.add(sessionTask({ recurring: false }));
	scheduler.start();
	await new Promise((resolve) => setTimeout(resolve, 80));
	scheduler.stop();
	assert.equal(events.length, 1);
	assert.equal(events[0]!.kind, "oneShot");
});
