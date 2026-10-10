/**
 * Model-facing message bodies for scheduler deliveries.
 *
 * Fired prompts arrive as user messages (queued, follow-up delivery) with a
 * short header that attributes them to pi-cron, so the model can tell a
 * scheduled trigger apart from something the human typed.
 */

import { cronToHuman, formatLocalTime } from "./cron.ts";
import type { FireEvent, MissedEvent } from "./scheduler.ts";

function oneLine(text: string, maxLen = 100): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}...` : collapsed;
}

export function formatFireMessage(event: FireEvent): string {
	const kind =
		event.kind === "final"
			? "recurring, final fire"
			: event.task.recurring
				? "recurring"
				: "one-shot";
	const header = `[pi-cron] Scheduled task fired (${kind}): ${cronToHuman(event.task.cron)} [id ${event.task.id}]`;
	const lines = [header];
	if (event.kind === "final") {
		lines.push(
			"This recurring task reached its age limit and was deleted. Recreate it with CronCreate if it should continue.",
		);
	}
	if (event.kind === "recurring" && event.nextRunAt !== null) {
		lines.push(`Next fire: ${formatLocalTime(event.nextRunAt)}.`);
	}
	lines.push("", event.task.prompt);
	return lines.join("\n");
}

export function formatMissedMessage(missed: MissedEvent[]): string {
	if (missed.length === 0) return "";
	const lines = missed.map(
		(m) =>
			`- [id ${m.task.id}] was due ${formatLocalTime(m.scheduledFor)} (${cronToHuman(m.task.cron)}): ${oneLine(m.task.prompt)}`,
	);
	return [
		`[pi-cron] ${missed.length} scheduled one-shot task${missed.length === 1 ? " was" : "s were"} missed while no Pi session was running and ${missed.length === 1 ? "has" : "have"} been removed:`,
		...lines,
		"Recreate any that are still relevant with CronCreate.",
	].join("\n");
}
