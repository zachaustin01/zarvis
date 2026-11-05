# Keys, parking and done

[← README](../README.md)

## Keys

`j`/`k` or arrows move · `]`/`[` (or `PageDown`/`PageUp`, the wheel, a swipe, or the pager) turn the page when the list does not fit the window (nothing scrolls) · `Cmd/Ctrl+K` command palette (fuzzy-find a session or run any key action; `>` commands only, `@` sessions only) · `b` show/hide the project rail (wide windows) · `e` collapse/expand the event ticker · `E` (Shift+E) open/close the event list · `Tab`/`Shift+Tab` cycle Queue → Roles → Parked → Schedule (`h`/`t`/`p`/`s` jump straight there; not while typing in a box) · `i` jump to the interface session · `v` show/hide parked sessions on the Roles page (hidden by default; remembered) · `m`/`w` queue role filter (managers / workers only; again to clear; remembered) · `g`/`G` filter by project (chips under the header; remembered; blocked sessions in other projects stay counted) · `Enter` open in Claude (on a Roles-view checkout card: the session holding it) · `n` new Claude Code session · `r` rename
(overlay; Esc cancels; empty restores the app title) · `P` park (Shift+P) · `d` done · `u` unpark · `z` undo ·
`p` parked view · `s` schedule (`-`/`=` widen/narrow its window) · `$` costs (`v` project/manager, `-`/`=` range) · `/` search the role tree · `?` key sheet.

`n` opens a new session in the Claude desktop app via `claude://code/new`, in the selected
session's repo (its root, not its worktree), or a plain new session when nothing is selected.

## Park and done

`P` (Shift+P) parks the selected session: a one-line reason, an optional wake date (`YYYY-MM-DD`, blank for
none) and a handoff note (Enter or ⌘/Ctrl+Enter saves). A parked session leaves the "Needs you"
queue and shows dim with a hollow dot in the role tree; a *blocked* parked session still appears in
the queue, marked. When its wake date passes it is marked **wake ready** and returns to the queue.
`u` (or `P` again) unparks. `d` marks a session done: hidden everywhere unless you search the role
tree (`/`), where `d` brings it back. `z` undoes the last park, unpark or done.

`p` opens the **Parked** view: every parked session with its reason, when and by whom it was parked
(a manager's name, or "by hand"), the wake date, and the full handoff note. `/` searches names,
reasons and notes; `u` unparks the selected one.

### Managers parking their own workers

A manager can park a finished worker so it drops out of your attention and can be found again:

```bash
npm run park -- park <workerSessionId> --by <managerSessionId> --reason "PR 7 merged" --note "..." [--wake YYYY-MM-DD]
npm run park -- unpark <workerSessionId> --by <managerSessionId>
npm run park -- list [--by <managerSessionId>]
```

It writes the same `parked` entry as the UI (plus `parkedBy`), straight to `~/.zarvis/state.json`,
so it works with the server stopped and a running server picks it up within a second. Ids may be
CLI session ids or the app's `local_…` ids. Guardrails: `--by` is required and must be a manager; the
target must be a worker of that manager according to Zarvis's classification (never the interface or
a manager); a session that is blocked or working per its hook markers is refused unless `--force`;
`--dry-run` validates and prints what it would do. A refusal exits 1 with one line why. Parked
workers are listed under each manager's "Parked" subsection in `~/.zarvis/roster.md`, with the
reason, date, session id and the first line of the note.

The `zarvis-manager` skill tells managers when to park (their own workers, only once finished,
checked, and idle) and how. `npm run setup` fills in the absolute path of this clone in the
installed copy of that skill, so re-run it if you move the clone.

State lives in `~/.zarvis/state.json` (`parked`, `done`); nothing is written to Claude's files.
Endpoints: `POST /api/park`, `/api/unpark`, `/api/done`. Ticket-status wake conditions are not built.
