import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CronController, HEADLESS_SESSION_ONLY_NOTE } from "../controller.ts";
import { DurableStore, newTaskId, TaskStore, type CronTask } from "../tasks.ts";

const NOW = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();

function makeController(options: { maxJobs?: number } = {}): {
	controller: CronController;
	sessionTasks: TaskStore;
	durableFor: (cwd: string) => DurableStore;
	dir: string;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-ctrl-"));
	const sessionTasks = new TaskStore();
	const stores = new Map<string, DurableStore>();
	const durableFor = (cwd: string) => {
		let store = stores.get(cwd);
		if (!store) {
			store = new DurableStore(path.join(dir, cwd.replace(/[^a-z0-9]/gi, "_"), "scheduled-tasks.json"));
			stores.set(cwd, store);
		}
		return store;
	};
	const controller = new CronController({
		sessionTasks,
		durableFor,
		maxJobs: options.maxJobs ?? 50,
		now: () => NOW,
	});
	return { controller, sessionTasks, durableFor, dir };
}

const CWD = "/project";

test("create validates the cron expression", () => {
	const { controller } = makeController();
	assert.throws(() => controller.create({ cron: "bad", prompt: "p", recurring: true, durable: false }, CWD), /Invalid cron expression/);
	assert.throws(() => controller.create({ cron: "0 0 30 2 *", prompt: "p", recurring: true, durable: false }, CWD), /does not match any calendar date/);
});

test("create routes to the session store by default and the durable store opt-in", () => {
	const { controller, sessionTasks, durableFor } = makeController();
	const sessionTask = controller.create({ cron: "*/5 * * * *", prompt: "check", recurring: true, durable: false }, CWD);
	assert.equal(sessionTask.durable, false);
	assert.equal(sessionTasks.size, 1);

	const durableTask = controller.create({ cron: "*/5 * * * *", prompt: "check", recurring: true, durable: true }, CWD);
	assert.equal(durableTask.durable, true);
	assert.equal(durableFor(CWD).read().length, 1);
});

test("create enforces the job budget across stores", () => {
	const { controller } = makeController({ maxJobs: 2 });
	controller.create({ cron: "*/5 * * * *", prompt: "a", recurring: true, durable: false }, CWD);
	controller.create({ cron: "*/10 * * * *", prompt: "b", recurring: true, durable: true }, CWD);
	assert.throws(
		() => controller.create({ cron: "*/15 * * * *", prompt: "c", recurring: true, durable: false }, CWD),
		/Too many scheduled tasks \(max 2\)/,
	);
});

test("create returns human schedule and forward-looking next fire", () => {
	const { controller } = makeController();
	const result = controller.create({ cron: "0 9 * * *", prompt: "standup", recurring: true, durable: false }, CWD);
	assert.equal(result.humanSchedule, "daily at 09:00");
	assert.ok(result.nextRunAt! > NOW);
	assert.match(result.nextRunText, /in 23 hours/);
});

test("create warns about session-only tasks in headless mode", () => {
	const { controller } = makeController();
	const headless = controller.create({ cron: "*/5 * * * *", prompt: "p", recurring: true, durable: false }, CWD, "print");
	assert.equal(headless.note, HEADLESS_SESSION_ONLY_NOTE);
	const headlessDurable = controller.create({ cron: "*/5 * * * *", prompt: "p", recurring: true, durable: true }, CWD, "print");
	assert.equal(headlessDurable.note, undefined);
	const interactive = controller.create({ cron: "*/5 * * * *", prompt: "p", recurring: true, durable: false }, CWD, "tui");
	assert.equal(interactive.note, undefined);
});

test("remove deletes from either store and throws for unknown ids", () => {
	const { controller, sessionTasks, durableFor } = makeController();
	const sessionTask = controller.create({ cron: "*/5 * * * *", prompt: "a", recurring: true, durable: false }, CWD);
	const durableTask = controller.create({ cron: "*/5 * * * *", prompt: "b", recurring: true, durable: true }, CWD);

	assert.equal(controller.remove(sessionTask.id, CWD).id, sessionTask.id);
	assert.equal(sessionTasks.size, 0);
	assert.equal(controller.remove(durableTask.id, CWD).id, durableTask.id);
	assert.deepEqual(durableFor(CWD).read(), []);
	assert.throws(() => controller.remove("nope", CWD), /No scheduled task with id 'nope'/);
});

test("list merges both stores sorted by next fire time", () => {
	const { controller } = makeController();
	controller.create({ cron: "0 9 * * *", prompt: "later", recurring: true, durable: false }, CWD);
	controller.create({ cron: "*/5 * * * *", prompt: "sooner", recurring: true, durable: true }, CWD);

	const list = controller.list(CWD);
	assert.equal(list.length, 2);
	// 10:05 (every 5 minutes) fires before 09:00 tomorrow.
	assert.equal(list[0]!.promptPreview, "sooner");
	assert.equal(list[1]!.promptPreview, "later");
	assert.equal(list[1]!.durable, false);
	assert.equal(list[0]!.durable, true);
});

test("list prompt preview collapses and truncates", () => {
	const { controller } = makeController();
	const long = "word ".repeat(40);
	const result = controller.create({ cron: "*/5 * * * *", prompt: long, recurring: true, durable: false }, CWD);
	const [summary] = controller.list(CWD);
	assert.ok(summary!.promptPreview.length <= 83);
	assert.ok(summary!.promptPreview.endsWith("..."));
	assert.ok(!result.nextRunText.includes("\n"));
});

test("external durable tasks appear in list", () => {
	const { controller, durableFor } = makeController();
	const external: CronTask = {
		id: newTaskId(),
		cron: "0 12 * * *",
		prompt: "from another session",
		recurring: true,
		durable: true,
		createdAt: NOW - 60_000,
	};
	durableFor(CWD).upsert(external);
	const list = controller.list(CWD);
	assert.deepEqual(list.map((t) => t.id), [external.id]);
});
