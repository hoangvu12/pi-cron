/**
 * Environment-driven configuration.
 *
 *   PI_CRON_DISABLE         Kill switch: register nothing at all.
 *   PI_CRON_MAX_JOBS        Max scheduled tasks across stores (default 50).
 *   PI_CRON_MAX_AGE_DAYS    Recurring task age limit in days; 0 disables
 *                           expiry (default 30).
 *   PI_CRON_TICK_MS         Scheduler check interval (default 1000, min 250).
 *   PI_CRON_DISABLE_JITTER  Disable fire-time jitter.
 */

export const DEFAULT_MAX_JOBS = 50;
export const DEFAULT_MAX_AGE_DAYS = 30;
export const DEFAULT_TICK_MS = 1_000;
const MIN_TICK_MS = 250;

export function isEnvTruthy(value: string | undefined): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

export function isDisabled(): boolean {
	return isEnvTruthy(process.env["PI_CRON_DISABLE"]);
}

export function resolveMaxJobs(): number {
	const raw = Number(process.env["PI_CRON_MAX_JOBS"]);
	return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_JOBS;
}

export function resolveMaxAgeDays(): number {
	const raw = Number(process.env["PI_CRON_MAX_AGE_DAYS"]);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_AGE_DAYS;
}

export function maxAgeMsFromDays(days: number): number {
	return days > 0 ? days * 24 * 60 * 60 * 1000 : 0;
}

export function resolveTickMs(): number {
	const raw = Number(process.env["PI_CRON_TICK_MS"]);
	return Number.isFinite(raw) && raw >= MIN_TICK_MS ? Math.floor(raw) : DEFAULT_TICK_MS;
}

export function resolveJitterEnabled(): boolean {
	return !isEnvTruthy(process.env["PI_CRON_DISABLE_JITTER"]);
}
