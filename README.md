# Zarvis

Private, read-only attention queue for Claude Code desktop sessions. It shows which sessions are
blocked on a permission prompt (longest wait first); **Enter** opens that session in the Claude
desktop app via its `claude://` deep link. There is no approve/deny here, and Zarvis never writes
to Claude's files. Its only writes are `~/.zarvis/blocked/*.json` (hook markers) and
`~/.zarvis/state.json` (overlay names).

**Zero npm dependencies.** Needs only Node >= 22.13.

## Run

```bash
git clone https://github.com/zachaustin01/zarvis && cd zarvis
npm install && npm run dev      # or: node server.mjs
```

Open http://127.0.0.1:5274 (override with `ZARVIS_PORT`). The server binds to 127.0.0.1 only and
rejects any Host/Origin that is not its own. `npm install` installs nothing; it is optional.

## Install the hook (you edit your own settings)

Blocked state is not visible anywhere in Claude's files, so it comes from an opt-in hook. Add this
to `~/.claude/settings.json`, replacing the path with where you cloned this repo:

```json
{
  "hooks": {
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs set" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs clear" }] }],
    "PermissionDenied": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs clear" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/zarvis/hooks/zarvis-hook.mjs clear" }] }]
  }
}
```

Try it without the hook by piping a fake payload (use a real `cliSessionId` from a desktop session):

```bash
echo '{"session_id":"<cliSessionId>","cwd":"/path/to/repo","message":"Claude needs your permission to use Bash"}' | node hooks/zarvis-hook.mjs set
```

## Keys

`j`/`k` or arrows move · `Enter` open in Claude · `r` rename (overlay; Esc cancels; empty restores
the app title) · `?` key sheet.

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
