# The hook

[← README](../README.md)

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
