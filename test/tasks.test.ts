import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DURABLE_FILE_NAME,
	DurableStore,
	newTaskId,
	parseTask,
	resolvePiDir,
	TaskStore,
	type CronTask,
} from "../tasks.ts";

function tmpDir(prefix = "pi-cron-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
	return {
		id: newTaskId(),
		cron: "*/5 * * * *",
		prompt: "check the build",
		recurring: true,
		durable: false,
		createdAt: Date.now(),
		...overrides,
	};
}

test("TaskStore add/list/remove/update", () => {
	const store = new TaskStore();
	const a = makeTask({ createdAt: 200 });
	const b = makeTask({ createdAt: 100 });
	store.add(a);
	store.add(b);
	assert.equal(store.size, 2);
	assert.deepEqual(
		store.list().map((t) => t.id),
		[b.id, a.id],
	);
	assert.deepEqual(store.get(a.id), a);

	store.update({ ...a, lastFiredAt: 12345 });
	assert.equal(store.get(a.id)!.lastFiredAt, 12345);

	assert.equal(store.remove(a.id), true);
	assert.equal(store.remove(a.id), false);
	assert.equal(store.size, 1);
});

test("parseTask tolerates malformed entries", () => {
	assert.equal(parseTask(null), null);
	assert.equal(parseTask("nope"), null);
	assert.equal(parseTask({ id: "x" }), null); // missing cron/prompt
	assert.equal(parseTask({ id: "x", cron: "* * * * *", prompt: "p" })!.recurring, false);
	const withDefaults = parseTask({ id: "x", cron: "* * * * *", prompt: "p" })!;
	assert.equal(typeof withDefaults.createdAt, "number");
	const full = parseTask({
		id: "x",
		cron: "* * * * *",
		prompt: "p",
		recurring: true,
		durable: true,
		createdAt: 5,
		lastFiredAt: 9,
		sessionId: "s1",
	})!;
	assert.deepEqual(
		[full.recurring, full.durable, full.createdAt, full.lastFiredAt, full.sessionId],
		[true, true, 5, 9, "s1"],
	);
});

test("resolvePiDir: nearest existing .pi wins, subdirs share it", () => {
	const root = tmpDir("pi-cron-root-");
	const sub = path.join(root, "packages", "app");
	fs.mkdirSync(sub, { recursive: true });
	fs.mkdirSync(path.join(root, ".pi"));

	assert.equal(resolvePiDir(root), path.join(root, ".pi"));
	assert.equal(resolvePiDir(sub), path.join(root, ".pi"));
});

test("resolvePiDir: falls back to cwd when no .pi exists", () => {
	// Build a nested tree with no .pi anywhere.
	const root = tmpDir("pi-cron-bare-");
	const sub = path.join(root, "a", "b");
	fs.mkdirSync(sub, { recursive: true });
	assert.equal(resolvePiDir(sub), path.join(sub, ".pi"));
});

test("DurableStore: missing file reads as empty, write round-trips", () => {
	const dir = tmpDir();
	const store = new DurableStore(path.join(dir, ".pi", DURABLE_FILE_NAME));
	assert.deepEqual(store.read(), []);

	const task = makeTask({ durable: true });
	store.upsert(task);
	assert.deepEqual(store.read().map((t) => t.id), [task.id]);
	// The store must have created the directory.
	assert.ok(fs.existsSync(store.filePath));
});

test("DurableStore: upsert replaces by id, remove deletes", () => {
	const store = new DurableStore(path.join(tmpDir(), ".pi", DURABLE_FILE_NAME));
	const task = makeTask({ durable: true });
	store.upsert(task);
	store.upsert({ ...task, lastFiredAt: 777, prompt: "updated" });
	assert.equal(store.read().length, 1);
	assert.equal(store.read()[0]!.lastFiredAt, 777);

	assert.equal(store.remove(task.id), true);
	assert.equal(store.remove(task.id), false);
	assert.deepEqual(store.read(), []);
});

test("DurableStore: corrupt file yields last known good", () => {
	const filePath = path.join(tmpDir(), ".pi", DURABLE_FILE_NAME);
	const store = new DurableStore(filePath);
	const task = makeTask({ durable: true });
	store.upsert(task);

	fs.writeFileSync(filePath, "{not json");
	// The in-memory cache survives; a fresh store sees empty rather than throwing.
	assert.equal(store.read().length, 1);
	assert.deepEqual(new DurableStore(filePath).read(), []);
});

test("DurableStore: maybeReload picks up external writes", () => {
	const filePath = path.join(tmpDir(), ".pi", DURABLE_FILE_NAME);
	const storeA = new DurableStore(filePath);
	const storeB = new DurableStore(filePath);

	const task = makeTask({ durable: true });
	storeA.upsert(task);

	// Size or mtime changed on disk -> B notices without a full re-read.
	const reloaded = storeB.maybeReload();
	assert.deepEqual(reloaded.map((t) => t.id), [task.id]);

	// No change -> maybeReload keeps returning the cached list.
	assert.deepEqual(storeB.maybeReload().map((t) => t.id), [task.id]);
});

test("DurableStore: maybeReload notices deletion", () => {
	const filePath = path.join(tmpDir(), ".pi", DURABLE_FILE_NAME);
	const store = new DurableStore(filePath);
	store.upsert(makeTask({ durable: true }));
	fs.rmSync(filePath);
	assert.deepEqual(store.maybeReload(), []);
});
