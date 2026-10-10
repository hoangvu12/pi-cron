import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCK_STALE_MS, SchedulerLock } from "../lock.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-lock-"));
}

test("acquires a free lock and reports ownership", () => {
	const lock = new SchedulerLock(tmpDir());
	assert.equal(lock.tryAcquire("owner-a", 111), true);
	assert.equal(lock.owns("owner-a"), true);
	assert.equal(lock.owns("owner-b"), false);
});

test("second owner cannot acquire a live lock", () => {
	const dir = tmpDir();
	const lockA = new SchedulerLock(dir);
	const lockB = new SchedulerLock(dir);
	// Real pid so the liveness probe agrees with the fresh heartbeat.
	assert.equal(lockA.tryAcquire("owner-a", process.pid), true);
	assert.equal(lockB.tryAcquire("owner-b", process.pid), false);
	assert.equal(lockA.owns("owner-a"), true);
});

test("re-acquiring as the same owner succeeds and keeps the lock", () => {
	const lock = new SchedulerLock(tmpDir());
	assert.equal(lock.tryAcquire("owner-a", 111), true);
	assert.equal(lock.tryAcquire("owner-a", 111), true);
	assert.equal(lock.owns("owner-a"), true);
});

test("refresh bumps the heartbeat and only works for the owner", () => {
	const lock = new SchedulerLock(tmpDir());
	assert.equal(lock.refresh("owner-a"), false); // nothing acquired yet
	assert.equal(lock.tryAcquire("owner-a", 111), true);
	assert.equal(lock.refresh("owner-a"), true);
	assert.equal(lock.refresh("owner-b"), false);
});

test("stale heartbeat allows takeover", () => {
	const dir = tmpDir();
	const lockA = new SchedulerLock(dir);
	const lockB = new SchedulerLock(dir);
	const t0 = 1_000_000;
	assert.equal(lockA.tryAcquire("owner-a", 111, t0), true);

	const later = t0 + LOCK_STALE_MS + 1;
	assert.equal(lockA.isStale(lockA.read()!, later), true);
	assert.equal(lockB.tryAcquire("owner-b", 222, later), true);
	assert.equal(lockB.owns("owner-b"), true);
	assert.equal(lockA.owns("owner-a"), false);
});

test("dead pid makes the lock stale", () => {
	const dir = tmpDir();
	const lock = new SchedulerLock(dir);
	const now = Date.now();
	fs.writeFileSync(
		path.join(dir, "cron.lock"),
		JSON.stringify({ owner: "gone", pid: -1, createdAt: now, heartbeatAt: now }),
	);
	assert.equal(lock.isStale(lock.read()!, now), true);
	assert.equal(lock.tryAcquire("owner-a", process.pid, now), true);
});

test("release frees the lock for the next owner", () => {
	const dir = tmpDir();
	const lockA = new SchedulerLock(dir);
	const lockB = new SchedulerLock(dir);
	assert.equal(lockA.tryAcquire("owner-a", 111), true);

	// A non-owner cannot release someone else's lock.
	lockB.release("owner-b");
	assert.equal(lockA.owns("owner-a"), true);

	lockA.release("owner-a");
	assert.equal(lockA.owns("owner-a"), false);
	assert.equal(lockB.tryAcquire("owner-b", 222), true);
});

test("corrupt lock file is treated as free", () => {
	const dir = tmpDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "cron.lock"), "garbage");
	const lock = new SchedulerLock(dir);
	assert.equal(lock.read(), null);
	assert.equal(lock.tryAcquire("owner-a", 111), true);
});
