/**
 * CronCreate / CronDelete / CronList tool definitions.
 *
 * The tools are a thin layer over CronController: schemas, descriptions, and
 * result formatting. Validation lives in the controller so it stays testable
 * without a Pi runtime.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLocalTime, formatRelative } from "./cron.ts";
import { type CronController, type CreateResult, type TaskSummary } from "./controller.ts";
import { renderCronCall, renderCronResult } from "./render.ts";

export const CRON_CREATE_TOOL_NAME = "CronCreate";
export const CRON_DELETE_TOOL_NAME = "CronDelete";
export const CRON_LIST_TOOL_NAME = "CronList";

const OFF_MINUTE_GUIDANCE = `## Off-minute scheduling

When the user's request is approximate, avoid the :00 and :30 minute marks — everyone's "9am" lands there. Pick a nearby minute instead: "every morning around 9" → "57 8 * * *"; "hourly" → "7 * * * *". Only use :00 or :30 when the user names that exact time and means it.`;

function buildCreateDescription(maxAgeDays: number): string {
	return `Schedule a prompt to run at a future time — recurring on a cron schedule, or once at a specific time. When a task fires, its prompt is delivered to this Pi session as a queued message, and the model acts on it.

Uses the standard 5-field cron expression in the user's local timezone: minute hour day-of-month month day-of-week. Examples: "*/5 * * * *" (every 5 minutes), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am), "30 14 28 2 *" (Feb 28 at 2:30pm). Fields support lists (1,15), ranges (1-5), steps (*/10, 5-50/10), and names (mon-fri, jan-mar).

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" — fire once, then auto-delete. Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring tasks (recurring: true, the default)

Fire on every match until deleted. Recurring tasks expire after ${maxAgeDays} days: they fire one final time, then are deleted — mention this limit when the user asks for something permanent.

${OFF_MINUTE_GUIDANCE}

## Durability

By default (durable: false) the task lives only in this Pi session and is gone when it ends. Pass durable: true to persist it to .pi/scheduled-tasks.json in the project so it survives restarts. Only use durable: true when the user explicitly asks for persistence ("keep doing this every day"). Most "remind me in 5 minutes" requests should stay session-only.

## Runtime behavior

Tasks only fire while a Pi session is running in this project. Durable tasks resume automatically on the next launch; one-shot tasks whose time passed while no session was running are reported as missed at the next launch instead of silently firing late. A small jitter (max 15 min late for recurring, max 90 s early for one-shots on :00/:30) may shift fire times.

Returns the task id, a human-readable schedule, and the next fire time. Pass the id to ${CRON_DELETE_TOOL_NAME} to cancel.`;
}

const CREATE_PARAMS = Type.Object({
	cron: Type.String({
		description:
			'5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm once).',
		minLength: 1,
	}),
	prompt: Type.String({
		description: "The prompt to deliver when the task fires. Write it as an instruction to the agent.",
		minLength: 1,
	}),
	recurring: Type.Optional(
		Type.Boolean({
			description:
				"true (default) = fire on every cron match until deleted or expired. false = fire once at the pinned match, then auto-delete. Use false for one-shot reminders.",
		}),
	),
	durable: Type.Optional(
		Type.Boolean({
			description:
				"true = persist to .pi/scheduled-tasks.json and survive restarts. false (default) = in-memory only, dies when this session ends. Use true only when the user asks for persistence.",
		}),
	),
});

const DELETE_PARAMS = Type.Object({
	id: Type.String({
		description: "Task id returned by CronCreate.",
		minLength: 1,
	}),
});

const LIST_PARAMS = Type.Object({});

function formatCreateResultText(result: CreateResult): string {
	const lines = [
		`Scheduled ${result.humanSchedule} [id ${result.id}].`,
		`Next fire: ${result.nextRunText}.`,
		result.durable
			? "Durable — persists in .pi/scheduled-tasks.json and survives restarts."
			: "Session-only — dies when this Pi session ends.",
	];
	if (result.note) lines.push(result.note);
	return lines.join("\n");
}

function formatTaskLine(summary: TaskSummary): string {
	const next =
		summary.nextRunAt === null ? "no upcoming match" : formatLocalTime(summary.nextRunAt);
	const kind = summary.durable ? "durable" : "session-only";
	const recur = summary.recurring ? "recurring" : "one-shot";
	return `${summary.id}  ${summary.cron}  ${next}  ${recur}, ${kind}  "${summary.promptPreview}"`;
}

export interface RegisterCronToolsOptions {
	/** Recurring expiry in days, surfaced in the create description. */
	maxAgeDays: number;
}

export function registerCronTools(pi: ExtensionAPI, controller: CronController, options: RegisterCronToolsOptions): void {
	const createTool: ToolDefinition<typeof CREATE_PARAMS> = {
		name: CRON_CREATE_TOOL_NAME,
		label: "Cron create",
		description: buildCreateDescription(options.maxAgeDays),
		promptSnippet: "Schedule a prompt to run at a future time — recurring on a cron schedule, or once (one-shot reminder).",
		parameters: CREATE_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = controller.create(
				{
					cron: params.cron,
					prompt: params.prompt,
					recurring: params.recurring ?? true,
					durable: params.durable ?? false,
				},
				ctx.cwd,
				ctx.mode,
			);
			return {
				content: [{ type: "text" as const, text: formatCreateResultText(result) }],
				details: result,
			};
		},
		renderCall: (args, theme) => renderCronCall("create", args, theme),
		renderResult: (result, _options, theme, context) =>
			renderCronResult("create", result.details, context.isError, theme),
	};

	const deleteTool: ToolDefinition<typeof DELETE_PARAMS> = {
		name: CRON_DELETE_TOOL_NAME,
		label: "Cron delete",
		description: `Cancel a scheduled task by id. Removes session-only and durable tasks alike.`,
		promptSnippet: "Cancel a scheduled task by its id.",
		parameters: DELETE_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const summary = controller.remove(params.id, ctx.cwd);
			return {
				content: [
					{
						type: "text" as const,
						text: `Deleted ${summary.humanSchedule} [id ${summary.id}].`,
					},
				],
				details: summary,
			};
		},
		renderCall: (args, theme) => renderCronCall("delete", args, theme),
		renderResult: (result, _options, theme, context) =>
			renderCronResult("delete", result.details, context.isError, theme),
	};

	const listTool: ToolDefinition<typeof LIST_PARAMS> = {
		name: CRON_LIST_TOOL_NAME,
		label: "Cron list",
		description: "List scheduled tasks with their ids, schedules, next fire times, and durability.",
		promptSnippet: "List scheduled cron tasks.",
		parameters: LIST_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const summaries = controller.list(ctx.cwd);
			const text =
				summaries.length === 0
					? "No scheduled tasks."
					: `${summaries.length} task(s):\n${summaries.map(formatTaskLine).join("\n")}`;
			return {
				content: [{ type: "text" as const, text }],
				details: { tasks: summaries },
			};
		},
		renderResult: (result, _options, theme, context) =>
			renderCronResult("list", result.details, context.isError, theme),
	};

	pi.registerTool(createTool);
	pi.registerTool(deleteTool);
	pi.registerTool(listTool);
}

/** Relative phrasing reused by the renderer for next-fire times. */
export function nextRunRelative(nextRunAt: number | null, nowMs: number): string {
	if (nextRunAt === null) return "no upcoming match";
	return `${formatLocalTime(nextRunAt)} (${formatRelative(nextRunAt, nowMs)})`;
}
