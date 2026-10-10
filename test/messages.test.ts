import test from "node:test";
import assert from "node:assert/strict";
import { formatFireMessage, formatMissedMessage } from "../messages.ts";
import type { FireEvent, MissedEvent } from "../scheduler.ts";
import { newTaskId, type CronTask } from "../tasks.ts";

void newTaskId;

function task(overrides: Partial<CronTask> = {}): CronTask {
	return {
		id: "tdeadbeef",
		cron: "*/5 * * * *",
		prompt: "Check the CI build and fix failures if red.",
		recurring: true,
		durable: false,
		createdAt: 0,
		...overrides,
	};
}

test("fire message attributes the trigger and includes the prompt", () => {
	const event: FireEvent = {
		task: task(),
		firedAt: 1000,
		kind: "recurring",
		nextRunAt: 2000,
	};
	const message = formatFireMessage(event);
	assert.ok(message.startsWith("[pi-cron] Scheduled task fired (recurring): every 5 minutes [id tdeadbeef]"));
	assert.ok(message.includes("Next fire:"));
	assert.ok(message.endsWith("Check the CI build and fix failures if red."));
});

test("one-shot fire message has no next-fire line", () => {
	const event: FireEvent = {
		task: task({ recurring: false, cron: "30 14 28 2 *" }),
		firedAt: 1000,
		kind: "oneShot",
		nextRunAt: null,
	};
	const message = formatFireMessage(event);
	assert.ok(message.includes("(one-shot)"));
	assert.ok(!message.includes("Next fire:"));
});

test("final fire message explains the expiry", () => {
	const event: FireEvent = {
		task: task(),
		firedAt: 1000,
		kind: "final",
		nextRunAt: null,
	};
	const message = formatFireMessage(event);
	assert.ok(message.includes("(recurring, final fire)"));
	assert.ok(message.includes("reached its age limit"));
	assert.ok(message.includes("Recreate it with CronCreate"));
});

test("missed message lists tasks with ids and due times", () => {
	const missed: MissedEvent[] = [
		{ task: task({ id: "tabc1234", recurring: false, cron: "0 8 * * *" }), scheduledFor: 1737024000000 },
		{ task: task({ id: "tdef5678", recurring: false, prompt: "Deploy the hotfix" }), scheduledFor: 1737027600000 },
	];
	const message = formatMissedMessage(missed);
	assert.ok(message.startsWith("[pi-cron] 2 scheduled one-shot tasks were missed"));
	assert.ok(message.includes("[id tabc1234]"));
	assert.ok(message.includes("Deploy the hotfix"));
	assert.ok(message.includes("Recreate any that are still relevant"));
	assert.equal(formatMissedMessage([]), "");
});

test("single missed task uses singular phrasing", () => {
	const missed: MissedEvent[] = [
		{ task: task({ id: "tabc1234", recurring: false }), scheduledFor: 1737024000000 },
	];
	const message = formatMissedMessage(missed);
	assert.ok(message.includes("1 scheduled one-shot task was missed"));
});
