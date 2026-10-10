# pi-cron

Cron extension for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): one-shot reminders and recurring jobs that fire into the running session.

```
pi> every 30 minutes, check CI and delegate the fix if red
    → CronCreate { cron: "*/30 * * * *", prompt: "Check CI...", recurring: true }

pi> remind me at 2:30pm to deploy
    → CronCreate { cron: "30 14 <dom> <month> *", recurring: false }
```

When a task fires, its prompt is delivered to the session as a queued follow-up message — the same channel steering messages use — so it never interrupts a running turn: it runs after pending work settles. Compose it with [pi-subagent](https://www.npmjs.com/package/@mjakl/pi-subagent) by letting the scheduled prompt delegate ("check CI, and delegate the fix if red") or with any other tool the session has.

## Install

```bash
pi install @mjakl/pi-cron
```

Or load locally while developing:

```bash
pi -e .
```

## Tools

| Tool | Purpose |
|---|---|
| `CronCreate` | Schedule a prompt — recurring on a 5-field cron expression, or one-shot at a pinned time. `durable: true` persists to `.pi/scheduled-tasks.json`. |
| `CronDelete` | Cancel a task by id. |
| `CronList` | List tasks with ids, schedules, next fire times, and durability. |

### One-shot reminders

`recurring: false` pins minute/hour/day/month and fires once, then auto-deletes:

```
"remind me at 2:30pm today"  → cron "30 14 15 1 *", recurring: false
```

### Recurring jobs

```
"*/5 * * * *"  every 5 minutes      "0 9 * * 1-5"  weekdays at 9am
"7 * * * *"    hourly (off-minute)  "30 14 28 2 *"  Feb 28 at 2:30pm
```

Standard Vixie-cron field syntax: lists (`1,15`), ranges (`1-5`), steps (`5-50/10`), month/weekday names (`jan-mar`, `mon-fri`). All times are local.

## How firing works

- **Session-only (default):** the task lives in memory and dies with the session. Fine for "remind me in 5 minutes".
- **Durable (`durable: true`):** the task is written to `<project>/.pi/scheduled-tasks.json` (found by walking up to the nearest `.pi` directory, like git finds its root) and survives restarts. Subdirectory sessions share the project's tasks.
- **Exactly one session fires durable tasks** — a lock file (`.pi/cron.lock`, heartbeat + pid) elects an owner. Other sessions keep firing their own session-only tasks and take over within seconds if the owner dies.
- **Restart behavior:** recurring tasks resume at their next match and fire once per missed stretch (no catch-up spam). One-shot tasks whose time passed while no session was running are reported as missed at the next launch and removed.
- **Fire-time jitter:** recurring tasks may fire up to 10% of their period late (max 15 min); one-shots pinned to `:00`/`:30` may fire up to 90 s early. Deterministic per task, and it keeps load off the minute marks everyone lands on.
- **Expiry:** recurring tasks live at most 30 days — they fire one final time, then are deleted. Say so when the user asks for something permanent.
- **Budget:** at most 50 tasks across both stores.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PI_CRON_DISABLE` | off | Kill switch: register nothing. |
| `PI_CRON_MAX_JOBS` | `50` | Max tasks across stores. |
| `PI_CRON_MAX_AGE_DAYS` | `30` | Recurring expiry in days; `0` disables. |
| `PI_CRON_TICK_MS` | `1000` | Scheduler check interval (min 250). |
| `PI_CRON_DISABLE_JITTER` | off | Disable fire-time jitter. |

## Limitations

- Tasks fire only while a Pi session is running in the project. Nothing runs in the background when Pi is closed — durable tasks resume at their next match on the next launch.
- No webhook/remote triggers: everything is local time-based.
- Headless (`pi -p`) runs register the tools (a durable task created there fires in the next live session) but never run the scheduler loop, since the process exits right after the prompt.

## Development

```bash
npm install
npm test        # node --test (73 tests)
npm run check   # tsc --noEmit
npm pack --dry-run
```

## License

MIT
