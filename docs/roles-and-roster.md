# Roles, interface session and roster

[← README](../README.md)

## Roles

Every session is the **interface** (one), a **project manager**, or a **worker** (one layer under a
manager). The tree is Zarvis's own registry (`~/.zarvis/state.json`), not the app's spawn links.
Press `t` for the role tree, `h` for the queue.

- Tag by hand: `c`, then `i` / `m` / `w` / `x` (clear). In the tree, `Shift+C` makes every
  unclassified session a worker. From a terminal, use `npm run role` (see below).
- Tag at session start: put `[zarvis: role=manager]` (or `interface`; `worker parent=<session id>`, which loads the `zarvis-worker` skill) in the
  very first prompt, at its start (a mention later or mid-prompt is ignored). The hook records it under `~/.zarvis/roles/`; a hand-set role overrides it.
- Auto-promote on worker spawn: an untagged session that spawns a tagged worker (`[zarvis: role=worker ...]`, via `Agent` / `Task`, `start_session`, a `claude://code/new` link or `claude` CLI call in `Bash`, or Antigravity `swarm` / `invoke_subagent`) is automatically promoted to `manager` — both by the hook (`wx` write to `~/.zarvis/roles/`, never overwriting an existing tag) and by `classify()` whenever a live tagged worker names an unclassified parent or was spawned from it. An untagged session that spawns an *untagged* child is still only *suggested* as a manager, and a session explicitly cleared (`none`) is never promoted. Spawn links from the interface are ignored.
- A manager with a blocked worker is **waiting on worker** and Enter jumps to the worker, so a blocked
  leaf never appears once per tier. Rule breaks show a ▲ and never block anything.

### Role CLI

Set, clear or inspect roles in `~/.zarvis/state.json` from the command line (works with the server stopped, including for CLI-only or closed sessions that have no desktop record):

```bash
npm run role -- set <id> <interface|manager|worker|none> [--parent <managerId>] [--dry-run]
npm run role -- clear <id> [--dry-run]   # sets 'none' (same as `x` in the UI: overrides hook tags and spawn inference)
npm run role -- reset <id> [--dry-run]   # drops the manual entry in state.json (falls back to hook tag / spawn inference)
npm run role -- get <id> [--json]
npm run role -- list [--json]
```

`<id>` and `--parent` accept either a CLI session id or the desktop app's `local_…` id.

## Interface session

`npm run setup` also installs three skills from `skills/` to `~/.claude/skills/`: `zarvis-interface`,
`zarvis-manager` and `zarvis-worker`, with the same rules as the hook: a differing existing
`SKILL.md` is backed up first, only Zarvis's own `SKILL.md` files are touched, re-running is safe, `--dry-run`
writes nothing, and `--skills-dir <dir>` (or `CLAUDE_SKILLS_DIR`) picks another folder. With
`--settings <file>` the skill goes to a `skills/` folder beside that file. `npm run uninstall-hook`
removes it.

The skill tells an interface session its job: triage and route to project managers, orient from the
roster, what it may do, what to ask first, what never to do and how to hand work to a manager and
close the loop. `zarvis-manager` does the same for a project manager and its workers. `zarvis-worker` tells a worker
to work its whole brief in one turn and report to its manager once (done, blocked, or a named checkpoint), in a fixed shape. `n` then `i` opens a new session with
`[zarvis: role=interface]` and a line pointing at the skill prefilled in the prompt box (not sent); `n` then `m` does the same for a manager, with the roster line and a pointer to
`zarvis-manager`; `n` then `w` prefills `[zarvis: role=worker]` and a pointer to `zarvis-worker`. Sessions already open need a restart to see a newly installed skill.

## Roster

Zarvis keeps `~/.zarvis/roster.md` current: every manager with the workers attached to it, each
with its state and session ids. Duplicate untitled zero-activity `no signal` interface entries (for example left behind by CLI scratch or test runs) are suppressed whenever an active, titled or desktop-backed interface exists; use `npm run role -- clear <id>` to clear stale hook tags permanently. A manager session is an ordinary Claude session that knows nothing
about Zarvis, so `n` then `m` prefills its first prompt with the role tag plus a line pointing at
this file and one pointing at the `zarvis-manager` skill. It refreshes on every classify and every few seconds.

### Session lookup

The roster file lists managers and workers; to name *any* session (the interface asking "which managers
are active?") use the lookup CLI, which does the same join as the dashboard (CLI id → the app's record →
title, hand-set name, role, parent manager, project, branch, running state) and needs no server:

```bash
npm run roster -- list [--query "words"] [--role manager] [--manager <id>] [--running live|unknown|archived] [--all] [--json]
npm run roster -- get <id> [--json]   # CLI id, the app's local_… id, or a unique prefix
```

`--query` finds sessions by content: every word must hit a session's name, project, branch, park note, link
labels, **first prompt** or **last assistant reply** (read from the head and tail of its transcript, whole-word
substring matches, nothing fuzzy across prose), best match first, with `asked:` and `last said:` lines. It searches
the same default scope as `list` (add `--all` for older or archived sessions). The dashboard palette (`Cmd/Ctrl+K`)
matches the same text and quotes the hit when the name did not match. For anything deeper the interface falls back
to the app's `search_session_transcripts`.

It is read-only. `running` is `live` (a fresh hook signal; `state` says blocked / working / idle),
`unknown` (no signal: the app shuts idle session processes down, so "idle" and "closed" look the same),
or `archived`. Zarvis never guesses "not running". The `zarvis-interface` and `zarvis-manager` skills
tell agents to use this instead of reading `~/.zarvis`. `roster.md` now also carries each
interface/manager's app id and state, and points at this command.
