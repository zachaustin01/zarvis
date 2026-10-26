# Zarvis

Local, read-only attention queue for Claude Code desktop sessions. It shows which sessions are
blocked on a permission prompt (longest wait first), then which are working, then which are idle; **Enter** opens that session in the Claude
desktop app via its `claude://` deep link. There is no approve/deny here. While running, Zarvis
never writes to Claude's files: its only writes are `~/.zarvis/blocked/*.json` and `~/.zarvis/working/*.json` (hook markers),
`~/.zarvis/claims/*.json` (checkout claims, written by the hook and the claims CLI) and
`~/.zarvis/state.json` (overlay names). The one exception is `npm run setup`, which adds its hook
to your Claude settings and installs the `zarvis-interface` and `zarvis-manager` skills into `~/.claude/skills/` when you run it.

**Zero npm dependencies.** Needs only Node >= 22.13.

> **Unofficial.** Zarvis is a personal tool, not affiliated with or endorsed by Anthropic. It reads the
> Claude desktop app's local session records and uses its `claude://` links, none of which are a
> documented interface, so an app update can break it. It runs only on your machine and sends nothing anywhere.

## Run

```bash
git clone https://github.com/zachaustin01/zarvis && cd zarvis
npm run setup                   # installs the Claude Code hook (see below)
npm run dev                     # or: node server.mjs
```

Open http://127.0.0.1:5274 (override with `ZARVIS_PORT`). The server binds to 127.0.0.1 only and
rejects any Host/Origin that is not its own. `npm install` installs nothing; it is optional.

## The hook

Blocked state is not visible anywhere in Claude's files, so it comes from an opt-in hook. Without
it the queue is always empty. `npm run setup` adds it to `~/.claude/settings.json`:

- Only Zarvis's own entries are added. Your other hooks and settings are kept as they are.
- The previous file is backed up beside it (`settings.json.zarvis-backup-<time>`) first, and an
  invalid settings file is never written.
- Running it again is safe, including after moving the clone: it leaves exactly one set, pointing
  at the current `hooks/zarvis-hook.mjs`.
- `--dry-run` prints the result without writing; `--settings <file>` (or `CLAUDE_SETTINGS`) targets
  another settings file.
- Sessions already open need a restart to pick it up. After updating Zarvis, re-run `npm run setup` to
  install new hook events (`PermissionRequest`, `SubagentStop` were added for subagent prompts).

`npm run uninstall-hook` takes the entries out again. Setup is the one time Zarvis writes to
Claude files (the settings and the skills below), and only when you run it. Doing it by hand
instead, the entries are:

```json
{
  "hooks": {
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" set" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" set" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" start" }] }],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" resume" }] },
      { "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" guard", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" work" }] },
      { "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" guardpost", "timeout": 5 }] }
    ],
    "PermissionDenied": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" resume" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" idle" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" idle" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" done" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" agentstop" }] }]
  }
}
```

Try it without the hook by piping a fake payload (use a real `cliSessionId` from a desktop session):

```bash
echo '{"session_id":"<cliSessionId>","cwd":"/path/to/repo","message":"Claude needs your permission to use Bash"}' | node hooks/zarvis-hook.mjs set
```

## Keys

`j`/`k` or arrows move · `e` collapse/expand the event ticker · `Tab`/`Shift+Tab` cycle Queue → Roles → Parked (`h`/`t`/`p` jump straight there; not while typing in a box) · `i` jump to the interface session · `v` show/hide parked sessions on the Roles page (hidden by default; remembered) · `m`/`w` queue role filter (managers / workers only; again to clear; remembered) · `g`/`G` filter by project (chips under the header; remembered; blocked sessions in other projects stay counted) · `Enter` open in Claude · `n` new Claude Code session · `r` rename
(overlay; Esc cancels; empty restores the app title) · `P` park (Shift+P) · `d` done · `u` unpark · `z` undo ·
`p` parked view · `/` search the role tree · `?` key sheet.

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

## Roles

Every session is the **interface** (one), a **project manager**, or a **worker** (one layer under a
manager). The tree is Zarvis's own registry (`~/.zarvis/state.json`), not the app's spawn links.
Press `t` for the role tree, `h` for the queue.

- Tag by hand: `c`, then `i` / `m` / `w` / `x` (clear). In the tree, `Shift+C` makes every
  unclassified session a worker.
- Tag at session start: put `[zarvis: role=manager]` (or `interface`; `worker parent=<session id>`) in the
  very first prompt, at its start (a mention later or mid-prompt is ignored). The hook records it under `~/.zarvis/roles/`; a hand-set role overrides it.
- A session spawned by a manager becomes its worker; one that has spawned children is only
  *suggested* as a manager. Spawn links from the interface are ignored.
- A manager with a blocked worker is **waiting on worker** and Enter jumps to the worker, so a blocked
  leaf never appears once per tier. Rule breaks show a ▲ and never block anything.

## Interface session

`npm run setup` also installs two skills from `skills/` to `~/.claude/skills/`: `zarvis-interface`
and `zarvis-manager`, with the same rules as the hook: a differing existing
`SKILL.md` is backed up first, only Zarvis's own `SKILL.md` files are touched, re-running is safe, `--dry-run`
writes nothing, and `--skills-dir <dir>` (or `CLAUDE_SKILLS_DIR`) picks another folder. With
`--settings <file>` the skill goes to a `skills/` folder beside that file. `npm run uninstall-hook`
removes it.

The skill tells an interface session its job: triage and route to project managers, orient from the
roster, what it may do, what to ask first, what never to do and how to hand work to a manager and
close the loop. `zarvis-manager` does the same for a project manager and its workers. `n` then `i` opens a new session with
`[zarvis: role=interface]` and a line pointing at the skill prefilled in the prompt box (not sent); `n` then `m` does the same for a manager, with the roster line and a pointer to
`zarvis-manager`. Sessions already open need a restart to see a newly installed skill.

## Roster

Zarvis keeps `~/.zarvis/roster.md` current: every manager with the workers attached to it, each
with its state and session ids. A manager session is an ordinary Claude session that knows nothing
about Zarvis, so `n` then `m` prefills its first prompt with the role tag plus a line pointing at
this file and one pointing at the `zarvis-manager` skill. It refreshes on every classify and every few seconds.

## Checkout claims

Two sessions editing the same checkout trip over each other's uncommitted work. Zarvis makes that
visible and, through the hook, makes the second session ask first.

**What is enforced.** A session *claims* a checkout (the worktree root containing the file or the
`git` command) on its first Edit / Write / MultiEdit / NotebookEdit or `git` command there. The claim
is labelled with a Jira key found in the branch name (`PROJ-123`), else the branch name, or the key you
gave `claim <KEY>`, and is released when the session ends. When *another live session* holds the
checkout, the `guard` PreToolUse hook returns `permissionDecision: "ask"` naming the holder (name,
label, branch, last write), and you decide: **Allow** means "share this checkout". While a checkout
is shared, whole-tree git (`add -A` / `add .` / `add -u`, `commit -a`, `stash`, `checkout`, `switch`,
`reset`, `restore .`, `clean`, `rebase`, `merge`, `cherry-pick`, `pull`) asks **every time**, for the
holder and the sharer alike; a plain `git status` or a single-file edit does not. A subagent's calls
count as its parent session's, so they never conflict with it.

**Ask, never deny.** The hook never blocks anything on its own. On any internal error (an unreadable
claim file, a bad payload) or after a 400 ms self-timeout it prints nothing and exits 0, which changes
nothing about the tool call. It does only file reads on the hot path; the one exception is a single
`ps -o lstart=` call when a claim is created or another session's claim is being judged, to tell a
reused process id from the real one.

**What is not detected.** Only the write tools and `git` commands are seen. Other shell writes
(`sed -i`, redirects, `npm install`, a formatter run) are not. `git` is found as a command word, also
after `&&`, `;`, `|` and with `-C <dir>`, best effort: `git` hidden behind an alias, a script or `eval`
is not. A claim is per checkout (worktree root), not per file.

**Takeover.** A claim is taken over, silently, by the next session that writes there when its holder's
process is gone (or the pid now belongs to a different process), its session ended, or nobody wrote in
the checkout for 8 hours. Holders refresh their last-write time at most once a minute.

**Claim and release by hand.**

```bash
npm run claims -- claim PROJ-123 --by <sessionId> [--root <dir>] [--dry-run]   # label the checkout (default: the current directory's)
npm run claims -- release --by <sessionId> [--root <dir>] [--dry-run]           # no --root: all of that session's claims
npm run claims -- list [--json]
```

`--by` is a CLI session id or the app's `local_…` id. A refusal (another live session holds it) exits 1 with
one line why. Claims live in `~/.zarvis/claims/<id>.json` (id = first 16 hex of the sha1 of the checkout's
real path), written atomically; a new claim is created exclusively, so two sessions cannot both create it.

**Where you see them.** `~/.zarvis/roster.md` has a *Checkouts* section (root, label, branch, holder,
sharers, last write, live/stale); `GET /api/claims` and the live-update payload carry them; the dashboard
puts a `⛓ LABEL` chip on the holder's rows (`⇄` on a sharer's) and lists checkouts at the top of the Roles view.

**Upgrading.** The guard is two new hook entries (a second `PreToolUse` and `PostToolUse`, each with
`"timeout": 5`, running beside the existing ones). Re-run `npm run setup` and restart open sessions to pick them up.

## Pushing events

The footer ticker shows the last dozen state changes Zarvis sees. Sessions and scripts can add their own
lines, and they survive a page reload:

```bash
npm run event -- "pushed PROJ-12 to branch fix-login" --kind push --url https://github.com/me/repo/pull/12 --by <session id>
```

- `--kind` is `push`, `pr`, `info` (default), `done`, `warn`, or any other word of up to 20 characters (shown as a neutral tag).
  `--url` must be http(s), at most 300 characters. `--dry-run` prints the line without writing it.
- `--by` takes a CLI session id or the app's `local_…` id. Without it the command uses `CLAUDE_CODE_SESSION_ID` from
  the environment (set in Claude Code sessions), else the event has no session. The ticker shows the session's name when it knows it.
- Text is cut to 200 characters, one line, control characters stripped. A bad argument exits 1 with one line; trouble
  writing the file prints a line to stderr and exits 0, so a logging step never fails an agent's task.
- **File**: `~/.zarvis/events.jsonl` (`$ZARVIS_HOME`), one JSON object per line: `{"at":<ms>,"sessionId":"…","kind":"push","text":"…","url":"…"}`
  (`sessionId` and `url` optional). Each event is one `O_APPEND` write of one short line, which concurrent appenders on a local disk
  do not interleave (not guaranteed on network filesystems; the reader skips any torn line). Past 1000 lines the file is trimmed to the
  newest 500. The server serves the latest as `events` in the live payload and as JSON from `GET /api/events` (the same URL is the SSE stream
  when asked with `Accept: text/event-stream`).
- **Automatic events**: the existing `PostToolUse` hook logs `pushed <branch> to <remote>` after a successful `git push` and
  `opened a PR` (with the URL when `gh` prints it) after `gh pr create`. No extra setup; `npm run setup` is unchanged.
  Turn them off with `ZARVIS_AUTO_EVENTS=0` in the environment of the Claude session, or for good with `npm run event -- --auto off`
  (`--auto on` / `--auto status`).

To have an agent log other things, paste this into a project's `CLAUDE.md` (adjust the clone path):

```markdown
After every git push, run: npm run --prefix /path/to/zarvis event -- 'pushed <branch>' --kind push --by $CLAUDE_CODE_SESSION_ID
When a task is finished, run the same with --kind done and a one-line summary.
```

## Behaviour notes

- Working sessions come from the same hook: a prompt starts the clock, each tool call refreshes it, and
  Stop turns it into an idle entry (SessionStart makes one too), which lasts until SessionEnd or
  `ZARVIS_MAX_AGE_HOURS`, newest first. A working session quiet for 30 min (`ZARVIS_WORKING_MAX_AGE_MIN`) drops out,
  since an interrupted turn fires no Stop. A blocked session is never also listed as working.

- A subagent's permission prompt arrives under the parent's session id (tagged with `agent_id`), so it
  blocks the parent, showing the subagent's tool and command. Other agents' tool calls don't clear it,
  the parent's Stop doesn't either (a background subagent may still wait), and it clears when that
  agent's next tool call starts, the agent stops, a new prompt is submitted, or the session ends.
- A turn that ends on a question for you also counts as **needs you**: when Stop fires, the hook reads the
  transcript tail, and if the turn's last tool call was the desktop app's `wrap_up` with an `ask` (a recap
  alone does not count) or an unanswered `AskUserQuestion`, it writes a blocked marker with `kind: "question"`
  (row text "Waiting for your answer", the question as the command line) instead of an idle one. It clears like
  any blocked marker: a new prompt, the next tool call, SessionEnd. An unreadable transcript just means idle.
  No new hook events: nothing to re-run.
- Only sessions with their own marker appear (leaf-only); a parent waiting on a child never does.
- Markers are dropped if the session record is archived/deleted, the session has no record or
  transcript, or the marker is older than 12 h (`ZARVIS_MAX_AGE_HOURS`).
- Terminal-only sessions (no desktop record) are listed but cannot be opened.
- Env: `ZARVIS_HOME`, `ZARVIS_PORT`, `ZARVIS_DESKTOP_SESSIONS`, `ZARVIS_CLI_PROJECTS`, `ZARVIS_DRY_OPEN=1`
  (report the link instead of opening it).

## Test

```bash
npm test     # node --test, no test dependencies
```

## License

MIT, see [LICENSE](LICENSE).
