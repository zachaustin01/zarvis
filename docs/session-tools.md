# Session tools: links, schedule, costs, claims, events

[← README](../README.md)

## Session links

A session can attach links (a Dagster run, a served page, a PR, a report) to its own card. They show as small
cyan chips on the card in the queue and the role tree (three, then `+N` to show all); clicking one opens it in a
new tab and does not open the session. The palette finds a session by a link's label or host.

```bash
npm run link -- add https://dagster.example.com/runs/abc --label "Dagster run" --by <session id>
npm run link -- list [--by <session id>] [--json]
npm run link -- remove <url|number> [--by <session id>]
```

`--by` takes the CLI session id or the app's `local_…` id; without it the CLI uses `CLAUDE_CODE_SESSION_ID`
when the session's environment has it, otherwise it needs `--by`. Links live in `~/.zarvis/links/<session id>.json`
(under `ZARVIS_HOME`), up to 8 per session (the oldest drops); posting a URL again updates its label and moves it
last. A label is one line, 60 characters; a URL is at most 300 characters. URLs are untrusted: only `http:` and
`https:` are accepted (`localhost` too), as are file paths (`add /abs/path`, `~/x`, or relative to the cwd; stored as `file:///…`), with no spaces, control characters or `user:password@`, and the server and
the page both re-check before rendering. A file chip (▤) is a button, never a `file:` href: clicking asks the server to open it, and the server only acts on a file link that session posted and that exists. Documents and images open (html, pdf, png, jpg, svg, md, txt, csv, json, log, audio/video); anything else (a `.command`, `.app`, script) is only revealed in the file manager, and Shift-click always reveals. Links survive park and are removed with the session at SessionEnd.
`npm run roster -- get|list` shows them (`links` in `--json`). Sessions only learn about `npm run link` after
`npm run setup` copies the updated skills.

Files a session sends with `SendUserFile` and artifacts it publishes with `Artifact` (a publish, not list/read/delete or
an asset upload) are pinned to its card automatically by the hook, on `PostToolUse`, with no `npm run link` call. They
count toward the 8-link limit like any other link. An artifact chip is labelled with the page's `<title>` (HTML) or first `# heading` (Markdown); without one it is `Artifact<n>.<type>`. Off with `ZARVIS_AUTO_LINKS=0` or `"autoLinks": false` in `~/.zarvis/state.json`.

## Schedule

The Schedule view (`s`, or Tab) is a timeline of the upcoming runs of your scheduled jobs: one lane per job, a fixed
NOW marker, and a track that slides left with the clock so the future approaches the marker. Ticks are runs, the next
one is emphasised and counted down in the lane label ("in 12m"; amber within 5 minutes). `-` / `=` (or the buttons)
step the window through 3h, 12h, 24h and 7d; many jobs paginate with `]` / `[`. Future runs only: no history, no
results. Zarvis never runs, edits or reads anyone's jobs; it only shows what is registered.

```bash
npm run schedule -- add "Hourly check" --cron "0 * * * *" --note "sources" --link https://example.com/dash
npm run schedule -- add "Standup prep" --at "09:00" --note "weekday mornings"   # --every 30m|1h|1d, --at "09:00,13:00"
npm run schedule -- list [--json]
npm run schedule -- next "Hourly check" [--count 5]
npm run schedule -- remove "Hourly check"
```

Jobs live in `~/.zarvis/schedules.json` (under `ZARVIS_HOME`), at most 40; a name is one line of up to 60 characters
(re-adding a name replaces it), a note up to 200. `--cron` is standard 5-field cron in your local timezone: lists, ranges,
steps, month and weekday names, and day-of-month OR day-of-week when both are set. A time that does not exist on a
spring-forward day is skipped; one that happens twice on a fall-back day runs once; an impossible date (Feb 31) never
runs. `--every` and `--at` are sugar that become cron, so only intervals that divide the hour or day evenly are allowed.
`--link` takes an http(s) URL (a new tab) or a file path (a button that asks the server to open it, like session links).
The file is validated on write and on read. Sessions that run on a schedule learn about the CLI after `npm run setup` copies the updated skills.

**Which session owns it.** `--by <session id>` (the CLI id or the app's `local_…` id; both are stored when the app knows the
session) ties a schedule to the session that registered it; without `--by` it is unowned (a system cron job, say).
`add` with an existing name replaces the whole job (pass `--by` again to keep the owner);
`npm run schedule -- set <name> [--by <id>|none] [--cron …|--every …|--at …] [--note …] [--link <url|file>|none]` changes only
what you name, so existing jobs can be tied to a session later. The lane shows a `↳ session name` chip (name from your rename overlay, else
the app title, else a short id; hover for the ids and role): click it, or `j`/`k` to pick a lane and `Enter`, to jump to that session (the view
that shows it opens, parked and done included). A session the app no longer has, or has archived, shows dimmed as "(session gone)". The
palette finds schedules by name, cron words, note or owner name (Enter selects the lane), a session's card gets a `⏱ next 11:07` chip when
it owns one (click: the Schedule view on that lane), and `npm run roster -- get <id>` lists its schedules.

Importers: `lib/schedule-import.mjs` has one hook for read-only sources (shown tagged `claude`). None is wired in yet:
on the Mac this was written on, Claude's `~/.claude/jobs` holds background-session state, not schedules, and no
other readable file with a name and a cron exists, so nothing is guessed.

## Costs

The Costs view (`$`, or Tab) shows token usage and an **API-equivalent cost estimate** per project, or per manager (`v`), for
today, 7 days, 30 days or all time (`-`/`=`, or click). Each row has the cost, tokens by type (input, output, cache read,
cache write), the model mix, the session count, the manager / worker split and a daily cost bar chart; `j`/`k` + `Enter`
(or a click) lists that row's sessions ranked by cost, `Esc` goes back. A **manager row is the manager plus every worker
attached to it**, parked ones included. The same numbers, for an agent or a terminal:

```bash
npm run costs -- [--range today|7d|30d|all] [--group project|manager] [--project <name>] [--manager <name|id>] [--top N] [--json]
```

**Honesty.** Dollars are tokens x the published per-model API list price. If you are on a subscription that is not
what you are billed, so the view says "API-equivalent estimate" everywhere. A model with no price in the table is
**unpriced**: its tokens are shown, its cost is left out of the dollars and flagged, never guessed. Not modelled: the Batch API
discount, fast-mode premiums, the US data-residency multiplier, server-tool fees. Prices live in `lib/pricing.mjs`
(source: <https://platform.claude.com/docs/en/about-claude/pricing>, checked 2026-10-29); override or add models in
`~/.zarvis/pricing.json` (honours `ZARVIS_HOME`), per million tokens:

```json
{ "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite5m": 5, "cacheWrite1h": 8 } }
```

Model ids match exactly (date suffix ignored), then by family prefix (flagged "approximate"). Claude Haiku 5.5's long-prompt
tier (over 100k tokens per request) is priced per request.

**Where the tokens come from.** The `message.usage` of every assistant message in each session's transcript under
`~/.claude/projects` (subagent transcripts beside it count for their session; `<synthetic>` messages are skipped).
Transcripts repeat messages (streaming, resumes), so each is counted once by message id + request id; a resumed session's
replay of earlier messages belongs to the session that started first. Files are read incrementally and cached by path,
mtime and size, so only the first scan of a big history is slow (it runs in the background at server start; the view shows
partial numbers while it finishes). Days are local days. Nothing is written to Claude's files.

**Projects.** Every session already has a project: the repo folder it runs in (worktrees roll up to their repo). To override:

```bash
npm run project -- set <session id|name> "<project>" [--by <your session id>]   # tag a session; a manager's tag covers its workers
npm run project -- clear <session id|name>
npm run project -- list [--json]
```

Resolution order: the session's own tag, then its manager's tag, then the folder name. Tags are stored in
`~/.zarvis/projects.json`; cards, the roster and `npm run roster` show the effective project.

## Checkout claims

Two sessions editing the same checkout trip over each other's uncommitted work. Zarvis makes that
visible and, through the hook, makes the second session ask first.

**What is enforced.** A session *claims* a checkout (the worktree root containing the file or the
`git` command) on its first Edit / Write / MultiEdit / NotebookEdit or `git` command there that can write; read-only git (`log`, `show`, `diff`, `status`, `grep`, `blame`, `rev-parse`,
`rev-list`, `ls-files`, `ls-tree`, `cat-file`, `merge-base`, `describe`, `shortlog`, `branch` / `tag` / `remote -v`
that only list, `stash list`, `worktree list`, ...) neither claims nor asks, so a manager reviewing its worker's
checkout with `git -C <dir> log / diff` never becomes a sharer. Commands that look read-only but write
(`diff --output`, `branch -d`, `tag -d`, `remote add`) and any git command Zarvis does not know count as writes. The claim
is labelled with a Jira key found in the branch name (`PROJ-123`), else the branch name, or the key you
gave `claim <KEY>`, and is released when the session ends. When *another live session* holds the
checkout, the `guard` PreToolUse hook returns `permissionDecision: "ask"` naming the holder (name,
label, branch, last write), and you decide: **Allow** means "share this checkout". While a checkout
is shared, whole-tree git (`add -A` / `add .` / `add -u`, `commit -a`, `stash`, `checkout`, `switch`,
`reset`, `restore .`, `clean`, `rebase`, `merge`, `cherry-pick`, `pull`) asks **every time**, for the
holder and the sharer alike; a plain `git status` or a single-file edit does not. The one exception on the
holder's side: if the only sharer is the holder's own manager (the `parent=` of its role tag, or a hand-set
role's parent), the holder's whole-tree git does not ask because of that share. A subagent's calls
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
npm run claims -- unshare <root> <session> --by <sessionId> [--dry-run]         # drop a sharer; --by is the holder or the sharer itself
npm run claims -- list [--json]
```

`--by` (and `<session>` in `unshare`) is a CLI session id or the app's `local_…` id; `unshare` is for a share made by mistake, without waiting for SessionEnd. A refusal (another live session holds it) exits 1 with
one line why. Claims live in `~/.zarvis/claims/<id>.json` (id = first 16 hex of the sha1 of the checkout's
real path), written atomically; a new claim is created exclusively, so two sessions cannot both create it.

**Where you see them.** `~/.zarvis/roster.md` has a *Checkouts* section (root, label, branch, holder,
sharers, last write, live/stale); `GET /api/claims` and the live-update payload carry them; the dashboard
puts a `⛓ LABEL` chip on the holder's rows (`⇄` on a sharer's) and lists checkouts at the top of the Roles view. Checkout cards are selectable like session rows (`j`/`k`, click); `Enter` or a double-click opens the holder in the Claude desktop app, and a holder with no app session (a terminal session) only shows a notice and its card is not marked as openable.

**Upgrading.** The guard is two new hook entries (a second `PreToolUse` and `PostToolUse`, each with
`"timeout": 5`, running beside the existing ones). Re-run `npm run setup` and restart open sessions to pick them up.

## Pushing events

The footer strip shows the newest event as plain text (session name, kind chip, what happened, dimmed detail; warnings, finished workers and sessions that need you are marked). Click `EVENTS` (or press `E`, which works with the strip collapsed) to open the last thirty of the forty it keeps, newest first and grouped by day; the label carries a count, highlighted while there are events you have not opened the list for. A new event slides in, and several arriving at once show in turn before it settles on the newest; reduced motion skips the slide. Sessions and scripts can add their own
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
