import test from "node:test";
import assert from "node:assert/strict";
import {
	cronToHuman,
	formatLocalTime,
	formatRelative,
	nextCronRunMs,
	parseCronExpression,
} from "../cron.ts";

function local(y: number, mo: number, d: number, h = 0, mi = 0): number {
	return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

test("parses valid expressions", () => {
	for (const expr of [
		"* * * * *",
		"*/5 * * * *",
		"0 9 * * *",
		"0 9 * * 1-5",
		"30 14 28 2 *",
		"1,15 * * * *",
		"10-30/5 * * * *",
		"5/15 * * * *",
		"0 9 * JAN-MAR *",
		"0 9 * * mon-fri",
		"0 9 * * 7",
		"  0   9  *  *  1  ",
	]) {
		assert.ok(parseCronExpression(expr) !== null, `should parse: ${expr}`);
	}
});

test("rejects invalid expressions", () => {
	for (const expr of [
		"",
		"* * * *",
		"* * * * * *",
		"60 * * * *",
		"* 24 * * *",
		"0 9 0 * *",
		"0 9 32 * *",
		"0 9 * 13 *",
		"0 9 * * 8",
		"a * * * *",
		"*/0 * * * *",
		"5-1 * * * *",
		"1-2-3 * * * *",
		"1,,2 * * * *",
	]) {
		assert.equal(parseCronExpression(expr), null, `should reject: ${JSON.stringify(expr)}`);
	}
});

test("rejects non-string input", () => {
	assert.equal(parseCronExpression(undefined as unknown as string), null);
});

test("next run: every minute", () => {
	const parsed = parseCronExpression("* * * * *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 30)), local(2026, 1, 15, 10, 31));
});

test("next run: strictly after the reference minute", () => {
	const parsed = parseCronExpression("* * * * *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 30) + 30_000), local(2026, 1, 15, 10, 31));
});

test("next run: every 5 minutes rounds to the next multiple", () => {
	const parsed = parseCronExpression("*/5 * * * *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 3)), local(2026, 1, 15, 10, 5));
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 5)), local(2026, 1, 15, 10, 10));
});

test("next run: daily at 9am from before and after", () => {
	const parsed = parseCronExpression("0 9 * * *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 8, 0)), local(2026, 1, 15, 9, 0));
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 0)), local(2026, 1, 16, 9, 0));
});

test("next run: weekday-only skips weekends", () => {
	// 2026-01-16 is a Friday; 2026-01-17 is a Saturday.
	const parsed = parseCronExpression("0 9 * * 1-5")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 16, 10, 0)), local(2026, 1, 19, 9, 0));
});

test("next run: dom/dow both restricted fire when either matches", () => {
	// 2026-02-15 is a Sunday. dom=1 OR dow=0 (Sunday) -> the next match from
	// Feb 15 12:00 is Sunday Feb 22 (dow), before Mar 1 (dom).
	const parsed = parseCronExpression("0 0 1 * 0")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 2, 15, 12, 0)), local(2026, 2, 22, 0, 0));
	// The next Sunday after Mar 1 is Mar 8.
	assert.equal(nextCronRunMs(parsed, local(2026, 3, 1, 1, 0)), local(2026, 3, 8, 0, 0));
});

test("next run: single restricted field must match", () => {
	const parsed = parseCronExpression("0 0 1 * *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 3, 15, 12, 0)), local(2026, 4, 1, 0, 0));
});

test("next run: month and day pinning with names", () => {
	const parsed = parseCronExpression("30 14 28 feb *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 3, 1, 12, 0)), local(2027, 2, 28, 14, 30));
});

test("next run: impossible dates return null", () => {
	const parsed = parseCronExpression("0 0 30 2 *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 1)), null);
});

test("next run: dow 7 is Sunday", () => {
	const parsed = parseCronExpression("0 9 * * 7")!;
	// 2026-01-18 is a Sunday.
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 12, 0)), local(2026, 1, 18, 9, 0));
});

test("next run: range with step expands values", () => {
	const parsed = parseCronExpression("10-30/5 * * * *")!;
	// Values are 10,15,20,25,30 — from 10:31 the next match is 11:10.
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 31)), local(2026, 1, 15, 11, 10));
});

test("next run: a/n starts at a and steps to the field max", () => {
	const parsed = parseCronExpression("5/15 * * * *")!;
	// Values are 5,20,35,50 — from 10:06 the next match is 10:20.
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 6)), local(2026, 1, 15, 10, 20));
});

test("next run: list fields pick the earliest match", () => {
	const parsed = parseCronExpression("0 9,12,17 * * *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 10, 0)), local(2026, 1, 15, 12, 0));
});

test("next run: year rollover", () => {
	const parsed = parseCronExpression("0 9 1 1 *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 12, 31, 12, 0)), local(2027, 1, 1, 9, 0));
});

test("next run: minute list with hour list", () => {
	const parsed = parseCronExpression("0,30 8 * * *")!;
	assert.equal(nextCronRunMs(parsed, local(2026, 1, 15, 8, 30)), local(2026, 1, 16, 8, 0));
});

test("cronToHuman: common shapes", () => {
	assert.equal(cronToHuman("* * * * *"), "every minute");
	assert.equal(cronToHuman("*/5 * * * *"), "every 5 minutes");
	assert.equal(cronToHuman("0 9 * * *"), "daily at 09:00");
	assert.equal(cronToHuman("0 9 * * 1-5"), "weekdays at 09:00");
	assert.equal(cronToHuman("0 9 * * 0,6"), "weekends at 09:00");
	assert.equal(cronToHuman("30 14 28 2 *"), "at 14:30 on February 28");
	assert.equal(cronToHuman("0 9 1 * *"), "at 09:00 on day 1 of the month");
});

test("cronToHuman: falls back to the raw expression", () => {
	assert.equal(cronToHuman("1,2,3 4,5 6,7 8,9 0,1"), "1,2,3 4,5 6,7 8,9 0,1");
	assert.equal(cronToHuman("not a cron"), "not a cron");
});

test("formatLocalTime and formatRelative", () => {
	const ms = local(2026, 1, 15, 9, 5);
	assert.equal(formatLocalTime(ms), "2026-01-15 09:05");
	assert.equal(formatRelative(ms + 30_000, ms), "in under a minute");
	assert.equal(formatRelative(ms + 3 * 60_000, ms), "in 3 minutes");
	assert.equal(formatRelative(ms + 90 * 60_000, ms), "in 2 hours");
	assert.equal(formatRelative(ms + 48 * 60 * 60_000, ms), "in 2 days");
	assert.equal(formatRelative(ms - 1_000, ms), "now");
});
