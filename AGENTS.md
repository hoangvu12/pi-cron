# AGENTS.md

Simple guidance for coding agents working in this repository.

## Repository setup

- Requirements: Node.js + npm
- Install dependencies:

```bash
npm install
```

- Check what would be published:

```bash
npm pack --dry-run
npm publish --dry-run --access public
```

## Local validation

- This package is a Pi extension (entry point: `index.ts`).
- Quick manual check with local package:

```bash
pi -e .
```

- Test suite and typecheck:

```bash
npm test
npm run check
```

## Code map

- `index.ts` — extension entry point: tool registration, session lifecycle, scheduler wiring, message delivery
- `cron.ts` — 5-field cron parsing, next-run computation, human formatting
- `tasks.ts` — task model, in-memory session store, durable JSON store with atomic writes
- `lock.ts` — scheduler lock (heartbeat + pid liveness) electing the one session that fires durable tasks
- `scheduler.ts` — tick loop, jitter, expiry, missed-task catch-up (check() is testable without timers)
- `controller.ts` — create/delete/list validation and store routing behind the tools
- `tools.ts` — CronCreate/CronDelete/CronList tool definitions and prompts
- `messages.ts` — model-facing bodies for fired and missed task reports
- `render.ts` — TUI rendering for tool calls/results
- `config.ts` — environment-driven configuration
- `README.md` — user-facing docs

## Design invariants

- The scheduler never keeps the process alive (timer is unref'd) and never throws into the host: tick/fire failures go to `onError`.
- Firing is "enqueue a message into the living session" via `pi.sendUserMessage(..., { deliverAs: "followUp" })` — never a separate model-calling daemon.
- Only the lock owner fires durable tasks; session-only tasks always fire locally. Any lock disagreement self-heals on the next probe.
- Jitter is deterministic per task id and never delays a one-shot past its pinned time; the catch-up grace (2 min) exceeds the maximum early jitter (90 s).
- Modules `cron.ts`/`tasks.ts`/`lock.ts`/`scheduler.ts`/`controller.ts` import Node built-ins only — no runtime dependencies on Pi packages. Only `tools.ts`/`render.ts`/`index.ts` touch Pi APIs.
- Internal imports use explicit `.ts` extensions (type-checked with `allowImportingTsExtensions`, stripped by Node and resolved by Pi's loader).

## Commit format (important)

Use the repository's existing style:

- Imperative mood
- Sentence case
- No prefix like `feat:` / `fix:` / `chore:`

Examples:

- `Add pi-cron extension for scheduled prompts`
- `Fix one-shot jitter for off-minute pins`

Keep commits focused (one logical change per commit).

## Release notes

- Package name: `@mjakl/pi-cron`
- For doc/code changes on npm, publish a new version (`npm version patch|minor|major`), then publish.
