# Roles, interface session and roster

[← README](../README.md)

## Roles

Every session is the **interface** (one), a **project manager**, or a **worker** (one layer under a
manager). The tree is Zarvis's own registry (`~/.zarvis/state.json`), not the app's spawn links.
Press `t` for the role tree, `h` for the queue.

- Tag by hand: `c`, then `i` / `m` / `w` / `x` (clear). In the tree, `Shift+C` makes every
  unclassified session a worker.
- Tag at session start: put `[zarvis: role=manager]` (or `interface`; `worker parent=<session id>`, which loads the `zarvis-worker` skill) in the
  very first prompt, at its start (a mention later or mid-prompt is ignored). The hook records it under `~/.zarvis/roles/`; a hand-set role overrides it.
- A session spawned by a manager becomes its worker; one that has spawned children is only
  *suggested* as a manager. Spawn links from the interface are ignored.
- A manager with a blocked worker is **waiting on worker** and Enter jumps to the worker, so a blocked
  leaf never appears once per tier. Rule breaks show a ▲ and never block anything.

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
with its state and session ids. A manager session is an ordinary Claude session that knows nothing
about Zarvis, so `n` then `m` prefills its first prompt with the role tag plus a line pointing at
this file and one pointing at the `zarvis-manager` skill. It refreshes on every classify and every few seconds.

### Session lookup

The roster file lists managers and workers; to name *any* session (the interface asking "which managers
are active?") use the lookup CLI, which does the same join as the dashboard (CLI id → the app's record →
title, hand-set name, role, parent manager, project, branch, running state) and needs no server:

```bash
npm run roster -- list [--role manager] [--manager <id>] [--running live|unknown|archived] [--all] [--json]
npm run roster -- get <id> [--json]   # CLI id, the app's local_… id, or a unique prefix
```

It is read-only. `running` is `live` (a fresh hook signal; `state` says blocked / working / idle),
`unknown` (no signal: the app shuts idle session processes down, so "idle" and "closed" look the same),
or `archived`. Zarvis never guesses "not running". The `zarvis-interface` and `zarvis-manager` skills
tell agents to use this instead of reading `~/.zarvis`. `roster.md` now also carries each
interface/manager's app id and state, and points at this command.
