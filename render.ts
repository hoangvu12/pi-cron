/**
 * TUI rendering for the Cron tool calls and results.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CreateResult, TaskSummary } from "./controller.ts";

type Fg = Theme["fg"];

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function oneLine(text: unknown): string {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

export function renderCronCall(
	kind: "create" | "delete",
	args: Record<string, unknown>,
	theme: Theme,
): Text {
	const fg = theme.fg.bind(theme);
	if (kind === "create") {
		const cron = String(args.cron ?? "...");
		const prompt = truncate(oneLine(args.prompt), 48);
		const durable = args.durable === true;
		const line =
			fg("muted", "⏰ schedule ") +
			fg("accent", cron) +
			fg("dim", durable ? " · durable" : " · session-only") +
			(prompt ? fg("dim", ` · ${prompt}`) : "");
		return new Text(line);
	}
	const id = String(args.id ?? "...");
	return new Text(fg("muted", "⏰ cancel ") + fg("accent", id));
}

export function renderCronResult(
	kind: "create" | "delete" | "list",
	details: unknown,
	isError: boolean,
	theme: Theme,
): Text {
	const fg = theme.fg.bind(theme);

	if (isError) {
		return new Text(fg("error", "✗ cron error"));
	}

	if (kind === "create") {
		const d = details as CreateResult | undefined;
		if (!d) return new Text(fg("success", "✓ scheduled"));
		const line =
			fg("success", "✓ ") +
			fg("accent", d.humanSchedule) +
			fg("dim", ` [${d.id}]`) +
			fg("muted", ` · next ${d.nextRunText}`);
		return new Text(line);
	}

	if (kind === "delete") {
		const d = details as TaskSummary | undefined;
		if (!d) return new Text(fg("success", "✓ deleted"));
		return new Text(
			fg("success", "✓ deleted ") + fg("accent", d.humanSchedule) + fg("dim", ` [${d.id}]`),
		);
	}

	const d = details as { tasks?: TaskSummary[] } | undefined;
	const count = d?.tasks?.length ?? 0;
	if (count === 0) return new Text(fg("muted", "no scheduled tasks"));
	const lines = d!.tasks!.slice(0, 10).map((t) => {
		const next = t.nextRunAt === null ? "none" : new Date(t.nextRunAt).toLocaleTimeString();
		return (
			fg("accent", t.id) +
			fg("dim", ` ${t.cron}`) +
			fg("muted", ` → ${next}`) +
			fg("dim", ` · ${t.recurring ? "recurring" : "one-shot"}, ${t.durable ? "durable" : "session"}`)
		);
	});
	const more = count > 10 ? [fg("muted", `... ${count - 10} more`)] : [];
	return new Text([fg("success", "⏰ ") + fg("muted", `${count} scheduled task(s)`), ...lines, ...more].join("\n"));
}
