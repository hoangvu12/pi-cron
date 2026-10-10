/**
 * Pi Cron Extension
 *
 * Scheduled prompts that fire into the running Pi session. One-shot
 * reminders ("remind me at 2:30pm") and recurring jobs ("check CI every
 * 30 minutes") are delivered as queued follow-up messages while the session
 * is alive; durable tasks persist in .pi/scheduled-tasks.json and resume
 * across restarts.
 *
 * Design notes:
 * - Firing is "enqueue a message into the living session", never a separate
 *   model-calling daemon: pi's message queue already defers delivery until
 *   pending work settles, so a fire never interrupts a running turn.
 * - Durable tasks fire from exactly one session per project (scheduler lock
 *   in .pi/cron.lock); other sessions keep their session-only tasks and can
 *   take over within seconds if the owner dies.
 * - Headless (print) sessions register the tools but never run the loop —
 *   the process exits right after the prompt.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDisabled, maxAgeMsFromDays, resolveJitterEnabled, resolveMaxAgeDays, resolveMaxJobs, resolveTickMs } from "./config.ts";
import { CronController } from "./controller.ts";
import { formatFireMessage, formatMissedMessage } from "./messages.ts";
import { CronScheduler } from "./scheduler.ts";
import { DURABLE_FILE_NAME, DurableStore, PI_DIR_NAME, resolvePiDir, TaskStore } from "./tasks.ts";
import { SchedulerLock } from "./lock.ts";
import { registerCronTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	if (isDisabled()) return;

	const owner = randomUUID();
	const sessionTasks = new TaskStore();
	// One durable store per resolved project directory, shared by the tools
	// and the scheduler so writes from either side refresh the same cache.
	const durableStores = new Map<string, DurableStore>();
	const durableFor = (cwd: string): DurableStore => {
		const projectDir = resolvePiDir(cwd);
		let store = durableStores.get(projectDir);
		if (!store) {
			store = new DurableStore(path.join(projectDir, DURABLE_FILE_NAME));
			durableStores.set(projectDir, store);
		}
		return store;
	};

	const controller = new CronController({
		sessionTasks,
		durableFor,
		maxJobs: resolveMaxJobs(),
	});

	registerCronTools(pi, controller, { maxAgeDays: resolveMaxAgeDays() });

	let scheduler: CronScheduler | undefined;

	/** Deliver a scheduler message as a queued follow-up user message. */
	const deliver = (message: string): void => {
		if (typeof pi.sendUserMessage !== "function") return;
		try {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		} catch (error) {
			console.warn(`[pi-cron] Could not deliver a scheduled message: ${String(error)}`);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// Headless sessions exit after the prompt — nothing to schedule.
		// (Tools still work there; CronCreate warns about session-only use.)
		if (ctx.mode === "print") return;
		if (scheduler) scheduler.stop();

		const durable = durableFor(ctx.cwd);
		const lock = new SchedulerLock(path.dirname(durable.filePath));
		scheduler = new CronScheduler({
			sessionTasks,
			durable,
			lock,
			owner,
			onFire: (event) => deliver(formatFireMessage(event)),
			onError: (error, phase) =>
				console.warn(`[pi-cron] Scheduler ${phase} error: ${String(error)}`),
			maxAgeMs: maxAgeMsFromDays(resolveMaxAgeDays()),
			tickMs: resolveTickMs(),
			jitter: resolveJitterEnabled(),
		});

		// One-shot tasks that came due while no session was running are
		// reported once and removed; recurring tasks resume at their next
		// match. Must run before start() so the loop never fires them late.
		const missed = scheduler.catchUpMissed(Date.now());
		if (missed.length > 0) {
			deliver(formatMissedMessage(missed));
		}

		scheduler.start();

		const durableCount = durable.read().length;
		if (ctx.hasUI && durableCount > 0) {
			ctx.ui.notify(
				`pi-cron: ${durableCount} durable scheduled task(s) active in ${PI_DIR_NAME}/scheduled-tasks.json`,
				"info",
			);
		}
	});

	// Fires for every teardown reason (quit, reload, new, resume, fork) and
	// is idempotent: stop the loop, release the lock, keep stores on disk.
	pi.on("session_shutdown", async () => {
		scheduler?.stop();
		scheduler = undefined;
	});
}
