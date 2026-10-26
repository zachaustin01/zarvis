# Zarvis

Private, read-only attention queue for Claude Code desktop sessions. It shows which sessions are
blocked on a permission prompt (longest wait first), then which are working, then which are idle; **Enter** opens that session in the Claude
desktop app via its `claude://` deep link. There is no approve/deny here. While running, Zarvis
never writes to Claude's files: its only writes are `~/.zarvis/blocked/*.json` and `~/.zarvis/working/*.json` (hook markers) and
`~/.zarvis/state.json` (overlay names). The one exception is `npm run setup`, which adds its hook
to your Claude settings when you run it.

**Zero npm dependencies.** Needs only Node >= 22.13.

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
- Sessions already open need a restart to pick it up.

`npm run uninstall-hook` takes the entries out again. Setup is the one time Zarvis writes to a
Claude file, and only when you run it. Doing it by hand instead, the entries are:

```json
{
  "hooks": {
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" set" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" start" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" resume" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" work" }] }],
    "PermissionDenied": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" resume" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" idle" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" idle" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node \"/ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs\" done" }] }]
  }
}
```

Try it without the hook by piping a fake payload (use a real `cliSessionId` from a desktop session):

```bash
echo '{"session_id":"<cliSessionId>","cwd":"/path/to/repo","message":"Claude needs your permission to use Bash"}' | node hooks/zarvis-hook.mjs set
```

## Keys

`j`/`k` or arrows move · `Enter` open in Claude · `n` new Claude Code session · `r` rename
(overlay; Esc cancels; empty restores the app title) · `?` key sheet.

`n` opens a new session in the Claude desktop app via `claude://code/new`, in the selected
session's repo (its root, not its worktree), or a plain new session when nothing is selected.

## Behaviour notes

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
- Working sessions come from the same hook: a prompt starts the clock, each tool call refreshes it, and
  Stop turns it into an idle entry (SessionStart makes one too), which lasts until SessionEnd or
  `ZARVIS_MAX_AGE_HOURS`, newest first. A working session quiet for 30 min (`ZARVIS_WORKING_MAX_AGE_MIN`) drops out,
  since an interrupted turn fires no Stop. A blocked session is never also listed as working.

