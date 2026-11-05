# Zarvis

A local, **read-only attention queue** for Claude Code desktop sessions. It shows which sessions are
blocked on a permission prompt (longest wait first), then which are working, then which are idle.
Press **Enter** to open one in the Claude desktop app. There is no approve/deny here.

- **Zero npm dependencies.** Needs only Node >= 22.13.
- **Local only.** Binds to 127.0.0.1, rejects foreign Host/Origin headers, sends nothing anywhere.

> **Unofficial.** Zarvis is a personal tool, not affiliated with or endorsed by Anthropic. It reads the
> Claude desktop app's local session records and uses its `claude://` links, none of which are a
> documented interface, so an app update can break it.

## Contents

[Quick start](#quick-start) · [What it shows](#what-it-shows) · [What Zarvis writes](#what-zarvis-writes) ·
[Setup details](#setup-details) · [Everyday use](#everyday-use) · [Reference docs](#reference-docs) ·
[Configuration](#configuration) · [Repo layout](#repo-layout) · [Test](#test) · [Contributing](#contributing)

## Quick start

```bash
git clone https://github.com/zachaustin01/zarvis && cd zarvis
npm run setup     # installs the Claude Code hook and the zarvis-* skills
npm run dev       # or: npm start
```

Then open <http://127.0.0.1:5274> (override with `ZARVIS_PORT`) and **restart any Claude sessions
that were already open** so they pick up the hook. `npm install` installs nothing and is optional.

## What it shows

| View | Key | Shows |
|---|---|---|
| Queue | `h` | Blocked, working and idle sessions, longest wait first |
| Roles | `t` | Interface → project managers → workers, plus checkouts |
| Parked | `p` | Sessions set aside, with reason, wake date and handoff note |
| Schedule | `s` | Timeline of upcoming scheduled jobs |
| Costs | `$` | API-equivalent token cost per project or manager |

`Tab` cycles the views, `Cmd/Ctrl+K` opens the command palette, `?` shows every key. Full list:
[docs/keys-and-parking.md](docs/keys-and-parking.md).

## What Zarvis writes

While running, Zarvis **never writes to Claude's files**. Its writes are all under `~/.zarvis/`
(or `$ZARVIS_HOME`): hook markers (`blocked/`, `working/`), `claims/`, `links/`, `roles/`,
`schedules.json`, `events.jsonl` and `state.json` (names, parked, done).

The one exception is `npm run setup`, run by you: it adds the hook to `~/.claude/settings.json` and
installs the `zarvis-interface`, `zarvis-manager` and `zarvis-worker` skills into `~/.claude/skills/`.

## Setup details

Blocked state is not visible anywhere in Claude's files, so it comes from an opt-in hook. Without it
the queue is always empty.

- Only Zarvis's own entries are added; your other hooks and settings are kept.
- The previous settings file is backed up first, and an invalid one is never written.
- Re-running `npm run setup` is safe, including after moving the clone or updating Zarvis (new hook events need it).
- `--dry-run` prints the result without writing; `--settings <file>` targets another settings file.
- `npm run uninstall-hook` removes the hook and skills again.

The hook entries, a manual install and a way to try it with a fake payload are in
[docs/hook.md](docs/hook.md).

## Everyday use

| I want to… | Do this |
|---|---|
| Jump to a blocked session | Open the Queue, `j`/`k` to select, `Enter` |
| Start a new session | `n` (then `i` / `m` / `w` to prefill an interface, manager or worker prompt) |
| Set a session aside | `P` to park it, `u` to unpark, `d` to mark done, `z` to undo |
| Tag roles by hand | `c`, then `i` / `m` / `w` / `x` |
| Find any session | `Cmd/Ctrl+K`, or `/` to search the role tree |
| Look up sessions from a terminal or agent | `npm run roster -- list` |
| Log an event, link or schedule from an agent | `npm run event`, `npm run link`, `npm run schedule` |

### Command-line tools

All run with the server stopped; none need extra setup beyond `npm run setup`.

| Command | Purpose | Docs |
|---|---|---|
| `npm run roster` | Look up sessions, roles, managers, running state | [roles-and-roster](docs/roles-and-roster.md#session-lookup) |
| `npm run park` | Managers park their finished workers | [keys-and-parking](docs/keys-and-parking.md#managers-parking-their-own-workers) |
| `npm run claims` | Claim / release a checkout, list holders | [session-tools](docs/session-tools.md#checkout-claims) |
| `npm run link` | Attach links to a session card | [session-tools](docs/session-tools.md#session-links) |
| `npm run event` | Push a line to the footer ticker | [session-tools](docs/session-tools.md#pushing-events) |
| `npm run schedule` | Register scheduled jobs for the timeline | [session-tools](docs/session-tools.md#schedule) |
| `npm run costs` | Token usage and API-equivalent cost | [session-tools](docs/session-tools.md#costs) |
| `npm run project` | Tag sessions with a project | [session-tools](docs/session-tools.md#costs) |

## Reference docs

| Doc | Covers |
|---|---|
| [docs/hook.md](docs/hook.md) | Hook entries, manual install, testing with a fake payload |
| [docs/keys-and-parking.md](docs/keys-and-parking.md) | Every key, park / done, manager parking CLI |
| [docs/roles-and-roster.md](docs/roles-and-roster.md) | Roles, interface/manager/worker skills, `roster.md`, session lookup |
| [docs/session-tools.md](docs/session-tools.md) | Links, schedule, costs, projects, checkout claims, events |
| [docs/behaviour.md](docs/behaviour.md) | Working/idle/background states, context use, page updates, env vars |

## Configuration

| Variable | Effect |
|---|---|
| `ZARVIS_PORT` | Port (default 5274) |
| `ZARVIS_HOME` | Where Zarvis keeps its files (default `~/.zarvis`) |
| `ZARVIS_MAX_AGE_HOURS` | Drop markers older than this (default 12) |
| `ZARVIS_WORKING_MAX_AGE_MIN` | Drop a quiet working session after this (default 30) |
| `ZARVIS_CONTEXT_WINDOW` | Reference window for the context bar (default 1,000,000) |
| `ZARVIS_AUTO_EVENTS=0` / `ZARVIS_AUTO_LINKS=0` | Turn off automatic ticker events / card links |
| `ZARVIS_DESKTOP_SESSIONS`, `ZARVIS_CLI_PROJECTS` | Override where session records are read from |
| `ZARVIS_DRY_OPEN=1` | Report the `claude://` link instead of opening it |

## Repo layout

```
server.mjs      HTTP server and live (SSE) payload
hooks/          zarvis-hook.mjs, the fail-safe Claude Code hook
lib/            logic: queue, roles, claims, costs, schedule, events, CLI cores
scripts/        thin entry points for the npm run commands
public/         the dashboard (plain JS/CSS, no build step)
skills/         zarvis-interface, -manager, -worker, copied by setup
test/           node --test suites and fixtures
docs/           reference documentation
```

## Test

```bash
npm test     # node --test, no test dependencies
```

Tests only ever use temp directories, never your real `~/.zarvis` or `~/.claude`.

## Contributing

Fork, branch, and open a PR against `main`. The short version:

1. Keep it **zero-dependency** (Node built-ins and plain browser JS).
2. Add tests, using temp dirs only; run `npm test`.
3. No personal paths, emails, session ids or tokens in code, tests or docs.
4. Hooks must never break a session: fail safe, stay fast.
5. Update the README or `docs/` when behaviour, env vars or commands change.

Details, UI rules and the PR checklist: [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
