/**
 * Five-field cron expression parsing and next-run computation.
 *
 * Supports the standard Vixie-cron field syntax:
 *
 *   minute hour day-of-month month day-of-week
 *
 * with `*`, lists (`a,b`), ranges (`a-b`), steps (`x/n`, `a-b/n`), and
 * three-letter names for months (jan..dec) and weekdays (sun..sat, with both
 * 0 and 7 meaning Sunday). All times are local.
 *
 * Semantics notes:
 * - `nextCronRunMs` returns the first matching minute strictly AFTER the
 *   reference time, so a task created exactly on a boundary fires at its
 *   next occurrence, never immediately.
 * - When both day-of-month and day-of-week are restricted (neither is `*`),
 *   a day matches when EITHER matches — the standard cron rule.
 * - The scan is capped at 367 days; expressions with no upcoming match
 *   (such as February 30) return null so callers can reject them.
 */

export interface CronField {
	/** Sorted unique matching values for this field. */
	values: number[];
	/** True only when the raw field was exactly `*`. Drives dom/dow OR semantics. */
	wildcard: boolean;
}

export interface ParsedCron {
	minute: CronField;
	hour: CronField;
	dom: CronField;
	month: CronField;
	dow: CronField;
}

const MONTH_NAMES: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
	sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export const MONTH_LABELS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
] as const;

export const DOW_LABELS = [
	"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

/** Reject expressions whose next match is farther out than this. */
export const MAX_SCAN_DAYS = 367;

function parseValue(token: string, names: Record<string, number> | undefined): number | null {
	if (names) {
		const named = names[token.toLowerCase()];
		if (named !== undefined) return named;
	}
	if (!/^\d+$/.test(token)) return null;
	return Number(token);
}

/**
 * Expand one comma-separated part of a field into concrete values.
 * Accepted forms: `*`, `a`, `a-b`, `x/n`, `a/n`, `a-b/n` (where a `x/n` step
 * applies to the whole field range).
 * Returns null on any syntax or range error.
 */
function parsePart(part: string, min: number, max: number, names?: Record<string, number>): number[] | null {
	let range = part;
	let step = 1;
	const stepMatch = part.match(/^(.+?)\/(\d+)$/);
	if (stepMatch) {
		range = stepMatch[1]!;
		step = Number(stepMatch[2]);
		if (step < 1) return null;
	}

	if (range === "*") {
		const out: number[] = [];
		for (let v = min; v <= max; v += step) out.push(v);
		return out;
	}

	let lo: number | null;
	let hi: number | null;
	if (range.includes("-")) {
		const dash = range.indexOf("-");
		const loRaw = range.slice(0, dash);
		const hiRaw = range.slice(dash + 1);
		if (hiRaw.includes("-")) return null; // a-b-c is not a thing
		lo = parseValue(loRaw, names);
		hi = parseValue(hiRaw, names);
	} else {
		lo = parseValue(range, names);
		// `a/n` means "from a, every n" (Vixie semantics); a lone `a` is just a.
		hi = step > 1 ? max : lo;
	}
	if (lo === null || hi === null || lo > hi) return null;
	if (lo < min || hi > max) return null;

	const out: number[] = [];
	for (let v = lo; v <= hi; v += step) out.push(v);
	return out.length > 0 ? out : null;
}

function parseField(
	raw: string,
	min: number,
	max: number,
	names?: Record<string, number>,
	normalize?: (value: number) => number,
): CronField | null {
	const values = new Set<number>();
	for (const part of raw.split(",")) {
		if (part === "") return null;
		const partValues = parsePart(part, min, max, names);
		if (!partValues) return null;
		for (const v of partValues) values.add(normalize ? normalize(v) : v);
	}
	if (values.size === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return { values: sorted, wildcard: raw === "*" };
}

/** Parse a cron expression. Returns null when the expression is invalid. */
export function parseCronExpression(expr: string): ParsedCron | null {
	if (typeof expr !== "string") return null;
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;

	const minute = parseField(parts[0]!, 0, 59);
	const hour = parseField(parts[1]!, 0, 23);
	const dom = parseField(parts[2]!, 1, 31);
	const month = parseField(parts[3]!, 1, 12, MONTH_NAMES);
	// day-of-week accepts 0-7; 7 is Sunday, normalized onto 0.
	const dow = parseField(parts[4]!, 0, 7, DOW_NAMES, (v) => v % 7);

	if (!minute || !hour || !dom || !month || !dow) return null;
	return { minute, hour, dom, month, dow };
}

/**
 * First matching time strictly after `fromMs`, in local time, or null when
 * no match exists within the scan window (MAX_SCAN_DAYS).
 */
export function nextCronRunMs(cron: ParsedCron, fromMs: number): number | null {
	const from = new Date(fromMs);
	// Start scanning at the minute boundary after fromMs.
	const start = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes());
	start.setMinutes(start.getMinutes() + 1);

	for (let dayOffset = 0; dayOffset <= MAX_SCAN_DAYS; dayOffset++) {
		const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
		const monthIdx = day.getMonth() + 1;
		if (!cron.month.values.includes(monthIdx)) continue;

		const domOk = cron.dom.wildcard || cron.dom.values.includes(day.getDate());
		const dowOk = cron.dow.wildcard || cron.dow.values.includes(day.getDay());
		const dayOk =
			cron.dom.wildcard && cron.dow.wildcard
				? true
				: !cron.dom.wildcard && !cron.dow.wildcard
					? domOk || dowOk // both restricted: EITHER matches (standard cron)
					: domOk && dowOk;

		if (!dayOk) continue;

		const year = day.getFullYear();
		const month = day.getMonth();
		const date = day.getDate();
		for (const h of cron.hour.values) {
			for (const m of cron.minute.values) {
				// Constructing local dates lets Date normalization absorb DST
				// shifts (a nonexistent 02:30 lands on the first valid time).
				const candidate = new Date(year, month, date, h, m, 0, 0).getTime();
				if (candidate > fromMs) return candidate;
			}
		}
	}
	return null;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local wall-clock time, e.g. `2026-03-31 14:05`. */
export function formatLocalTime(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Rough relative phrasing for a future timestamp: "in 3 minutes". */
export function formatRelative(ms: number, nowMs: number): string {
	const delta = ms - nowMs;
	if (delta <= 0) return "now";
	if (delta < 60_000) return "in under a minute";
	const minutes = Math.round(delta / 60_000);
	if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.round(hours / 24);
	return `in ${days} day${days === 1 ? "" : "s"}`;
}

function formatHM(h: number, m: number): string {
	return `${pad2(h)}:${pad2(m)}`;
}

function dowSet(values: number[]): string {
	const labels = values.map((v) => DOW_LABELS[v]!);
	return labels.join(", ").replace(/, ([^,]*)$/, " and $1");
}

/**
 * Best-effort human-readable summary of a cron expression, e.g.
 * "every 5 minutes", "weekdays at 09:07", "at 14:30 on February 28".
 * Falls back to the raw expression for anything unusual.
 */
export function cronToHuman(expr: string): string {
	const trimmed = expr.trim();

	// Step forms are easiest to detect on the raw expression.
	const everyMinuteStep = trimmed.match(/^\*\/(\d+) \* \* \* \*$/);
	if (trimmed === "* * * * *") return "every minute";
	if (everyMinuteStep) {
		const n = Number(everyMinuteStep[1]);
		return `every ${n} minute${n === 1 ? "" : "s"}`;
	}
	const everyHourStep = trimmed.match(/^\* \*\/(\d+) \* \*$/);
	if (everyHourStep) {
		const n = Number(everyHourStep[1]);
		return `every ${n} hour${n === 1 ? "" : "s"}`;
	}

	const parsed = parseCronExpression(trimmed);
	if (!parsed) return trimmed;
	const { minute, hour, dom, month, dow } = parsed;

	const times: string[] = [];
	for (const h of hour.values) {
		for (const m of minute.values) times.push(formatHM(h, m));
	}
	// Too many time slots to enumerate nicely — fall back to the raw form.
	if (times.length > 4) return trimmed;
	const timesText = times.join(", ").replace(/, ([^,]*)$/, " and $1");

	if (hour.wildcard && dom.wildcard && month.wildcard && dow.wildcard) {
		if (minute.wildcard) return "every minute";
		return `${times.map((t) => `:${t.slice(-2)}`).join(" and ")} past every hour`;
	}

	const domMonthText = () => {
		if (!month.wildcard && !dom.wildcard) {
			const months = month.values.map((v) => MONTH_LABELS[v - 1]!).join("/");
			return ` on ${months} ${dom.values.join("/")}`;
		}
		if (!month.wildcard) return ` in ${month.values.map((v) => MONTH_LABELS[v - 1]!).join("/")}`;
		if (!dom.wildcard) return ` on day ${dom.values.join("/")} of the month`;
		return "";
	};

	if (dom.wildcard && month.wildcard) {
		if (!dow.wildcard) {
			const isWeekdays =
				dow.values.length === 5 && dow.values.every((v) => v >= 1 && v <= 5);
			const isWeekends = dow.values.length === 2 && dow.values.includes(0) && dow.values.includes(6);
			if (isWeekdays) return `weekdays at ${timesText}`;
			if (isWeekends) return `weekends at ${timesText}`;
			return `on ${dowSet(dow.values)} at ${timesText}`;
		}
		if (hour.wildcard) return `at ${times.map((t) => `:${t.slice(-2)}`).join(" and ")} past every hour`;
		return `daily at ${timesText}`;
	}

	return `at ${timesText}${domMonthText()}`;
}
