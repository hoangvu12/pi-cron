/**
 * Integration test: drives the real extension factory with a fake
 * ExtensionAPI, runs a real scheduler session, and verifies that
 * - the three tools register,
 * - a due durable one-shot fires as a queued follow-up user message and is
 *   removed from the store,
 * - a long-overdue one-shot is reported as missed instead of fired,
 * - shutdown releases the scheduler lock.
 *
 * The due task is crafted to be overdue by ~10 s (inside the 2-minute
 * catch-up grace), so the scheduler fires it on its first tick — the test
 * needs no multi-minute waits.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { DURABLE_FILE_NAME, resolvePiDir } from "../tasks.ts";

interface RegisteredTool {
	name: string;
	execute: (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: { cwd: string; mode: string }) => Promise<unknown>;
}

interface FakeCtx {
	cwd: string;
	mode: string;
	hasUI: boolean;
	isProjectTrusted: () => boolean;
	ui: { notify: (message: string, level: string) => void };
}

function createFakePi(): {
	pi: {
		registerTool: (tool: RegisteredTool) => void;
		on: (event: string, handler: (event: unknown, ctx: FakeCtx) => Promise<void> | void) => void;
		sendUserMessage: (content: string, options?: { deliverAs?: string }) => void;
	};
	tools: RegisteredTool[];
	sent: { content: string; options?: { deliverAs?: string } }[];
	notifications: string[];
	startSession: (ctx: FakeCtx) => Promise<void>;
	shutdownSession: () => Promise<void>;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: FakeCtx) => Promise<void> | void>>();
	const tools: RegisteredTool[] = [];
	const sent: { content: string; options?: { deliverAs?: string } }[] = [];
	const notifications: string[] = [];

	return {
		pi: {
			registerTool: (tool) => tools.push(tool),
			on: (event, handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendUserMessage: (content, options) => sent.push({ content, options }),
		},
		tools,
		sent,
		notifications,
		startSession: async (ctx) => {
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({}, ctx);
			}
		},
		shutdownSession: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) {
				await handler({}, {} as FakeCtx);
			}
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

test("extension registers tools, fires due tasks, reports missed ones, and cleans up", async () => {
	process.env["PI_CRON_TICK_MS"] = "250";
	process.env["PI_CRON_DISABLE_JITTER"] = "1";

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-integration-"));
	const piDir = resolvePiDir(cwd);
	fs.mkdirSync(piDir, { recursive: true });
	const durablePath = path.join(piDir, DURABLE_FILE_NAME);

	const now = Date.now();
	// Due ~10 s ago (inside the catch-up grace): the scheduler fires it.
	const dueTask = {
		id: "t11111111",
		cron: "* * * * *",
		prompt: "Fire me: the integration task.",
		recurring: false,
		durable: true,
		createdAt: now - 70_000,
	};
	// Overdue by ~10 minutes (outside the grace): reported as missed.
	const missedTask = {
		id: "t22222222",
		cron: "* * * * *",
		prompt: "Missed me: the overdue task.",
		recurring: false,
		durable: true,
		createdAt: now - 10 * 60_000,
	};
	fs.writeFileSync(durablePath, JSON.stringify([dueTask, missedTask], null, 2));

	const harness = createFakePi();
	extension(harness.pi as unknown as ExtensionAPI);

	// 1. All three tools registered with the expected names.
	assert.deepEqual(
		harness.tools.map((t) => t.name).sort(),
		["CronCreate", "CronDelete", "CronList"],
	);

	// 2. Session start: catch-up runs before the loop starts.
	await harness.startSession({
		cwd,
		mode: "tui",
		hasUI: false,
		isProjectTrusted: () => true,
		ui: { notify: (message) => harness.notifications.push(message) },
	});

	const missedMessage = harness.sent.find((m) => m.content.includes("t22222222"));
	assert.ok(missedMessage, "missed task reported");
	assert.match(missedMessage!.content, /1 scheduled one-shot task was missed/);
	assert.match(missedMessage!.content, /Recreate any that are still relevant/);

	// 3. The due task fires as a queued follow-up message.
	const fired = await waitFor(() => harness.sent.some((m) => m.content.includes("t11111111")), 10_000);
	assert.ok(fired, "due task fired");
	const fireMessage = harness.sent.find((m) => m.content.includes("t11111111"))!;
	assert.match(fireMessage.content, /\[pi-cron\] Scheduled task fired \(one-shot\)/);
	assert.ok(fireMessage.content.endsWith("Fire me: the integration task."));
	assert.equal(fireMessage.options?.deliverAs, "followUp");

	// 4. Both tasks are gone from the durable store afterwards.
	const remaining = JSON.parse(fs.readFileSync(durablePath, "utf-8")) as unknown[];
	assert.deepEqual(remaining, []);

	// 5. CronList via the registered tool reflects the empty state.
	const listTool = harness.tools.find((t) => t.name === "CronList")!;
	const listResult = (await listTool.execute("call-1", {}, undefined, undefined, { cwd, mode: "tui" })) as {
		content: { type: string; text: string }[];
	};
	assert.match(listResult.content[0]!.text, /No scheduled tasks/);

	// 6. CronCreate through the tool layer persists a durable task.
	const createTool = harness.tools.find((t) => t.name === "CronCreate")!;
	const createResult = (await createTool.execute(
		"call-2",
		{ cron: "*/5 * * * *", prompt: "check the build", durable: true },
		undefined,
		undefined,
		{ cwd, mode: "tui" },
	)) as { content: { type: string; text: string }[]; details: { id: string } };
	assert.match(createResult.content[0]!.text, /Durable — persists/);
	const stored = JSON.parse(fs.readFileSync(durablePath, "utf-8")) as Array<{ id: string }>;
	assert.equal(stored.length, 1);
	assert.equal(stored[0]!.id, createResult.details.id);

	// 7. Shutdown releases the scheduler lock.
	await harness.shutdownSession();
	assert.equal(fs.existsSync(path.join(piDir, "cron.lock")), false);

	delete process.env["PI_CRON_TICK_MS"];
	delete process.env["PI_CRON_DISABLE_JITTER"];
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("print mode never starts the scheduler", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cron-print-"));
	const harness = createFakePi();
	extension(harness.pi as unknown as ExtensionAPI);
	await harness.startSession({ cwd, mode: "print", hasUI: false, isProjectTrusted: () => true, ui: { notify: () => {} } });

	// No lock, no loop, no delivered messages — the process exits anyway.
	assert.equal(fs.existsSync(path.join(resolvePiDir(cwd), "cron.lock")), false);
	assert.deepEqual(harness.sent, []);

	// But the tools still work for creating durable tasks.
	const createTool = harness.tools.find((t) => t.name === "CronCreate")!;
	const result = (await createTool.execute(
		"call-1",
		{ cron: "*/5 * * * *", prompt: "p" },
		undefined,
		undefined,
		{ cwd, mode: "print" },
	)) as { content: { type: string; text: string }[] };
	// Session-only default in headless mode carries the warning note.
	assert.match(result.content[0]!.text, /headless/);
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("kill switch disables registration entirely", () => {
	process.env["PI_CRON_DISABLE"] = "1";
	try {
		const harness = createFakePi();
		extension(harness.pi as unknown as ExtensionAPI);
		assert.equal(harness.tools.length, 0);
	} finally {
		delete process.env["PI_CRON_DISABLE"];
	}
});
