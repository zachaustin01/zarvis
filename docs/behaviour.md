# Behaviour notes, context use and updating

[← README](../README.md)

## Behaviour notes

- Working sessions come from the same hook: a prompt starts the clock, each tool call refreshes it, and
  Stop turns it into an idle entry (SessionStart makes one too), which lasts until SessionEnd or
  `ZARVIS_MAX_AGE_HOURS`, newest first. A working session quiet for 30 min (`ZARVIS_WORKING_MAX_AGE_MIN`) drops out,
  since an interrupted turn fires no Stop. A blocked session is never also listed as working.

- **Background tasks** (background Bash commands, Monitors, background subagents, workflows) show on a session's
  card as a pulsing `N bg` chip, and an idle session reads "Idle · N background tasks running" instead of
  plain idle. The source is the `background_tasks` list Claude Code puts in the Stop payload (it replaces
  `~/.zarvis/tasks/<session>.json`, so a missed completion heals at the next Stop; a finished task wakes the
  session, which ends in another Stop); a launch seen on PostToolUse adds one in between and `TaskStop` removes
  one. A task that vanished becomes one ticker event ("finished a background command: ..."; off with the other
  auto events). Tasks expire on their own (a Monitor at its timeout, anything else after 12 h) and SessionStart /
  SessionEnd clear them. No new hook events: nothing to re-run in `npm run setup`.

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

## Context use per session

Each row shows a thin bar, the session's token count ("235k") and an approximate share ("~24%"), and the interface
ring has an inner arc for the same figure. Amber from 70%, red from 90%. The tokens are exact: Zarvis reads the tail
of the session's transcript (read-only, cached by file time and size) and takes the last assistant message's
input, cache-read and cache-creation tokens. The percentage is against a **reference window**, because a session's
real window is not recorded anywhere Zarvis can read (model ids carry no 1M marker, and sessions already run past
200k). The reference is 1,000,000 by default; set `ZARVIS_CONTEXT_WINDOW` to a positive integer (for example
`200000`) to change it. A session with no usage yet shows nothing, never 0%. After a compaction the figure simply drops.

## Updating the page

Zarvis serves its own files with `no-store`, and the server publishes a short fingerprint of `public/`. When a file
changes on disk, an open page shows a banner ("A new version of Zarvis is ready" with an **Update** button). The command
palette (⌘/Ctrl+K, "Update app") opens a small dialog that checks the fingerprint and offers a **Hard refresh**: it drops
any service worker and cache and reloads the page on a fresh URL. A server-side change still needs the server restarted.
