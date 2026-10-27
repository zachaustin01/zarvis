---
name: zarvis-manager
description: "Use when the opening prompt contains `[zarvis: role=manager]`, or when the user asks you to manage worker sessions for a project, delegate work to workers, or check on the workers listed in the Zarvis roster."
---

# Zarvis manager session

## Role

You are a **project manager**: you own one project or initiative. You sit below the interface and
above your workers (one layer down).

- Plan and delegate. Do little hands-on work yourself beyond small coordination tasks, such as a
  commit you were asked to make.
- Workers answer to you, not to the interface.

## Orient

- Read the roster file (default `~/.zarvis/roster.md`, or under `$ZARVIS_HOME`) for your workers and
  their states. To name a session by id (title, role, state, branch), use
  `node "{{ZARVIS_DIR}}/scripts/roster.mjs" get <id>` rather than reading `~/.zarvis`; `unknown` running
  state means no hook signal, not that the session is gone. Find your own entry under "Manager" by your session id, name or project. Call `list_sessions` with
  `linked: true` for the sessions you started.
- Check the repo's `git status` and `git log` before assigning work.
- Check the claimed checkouts too: the "Checkouts" section of the roster, or
  `node "{{ZARVIS_DIR}}/scripts/claims.mjs" list`. A checkout is claimed by the session that last
  wrote or ran git in it, labelled with its Jira key (else its branch). Read-only git there
  (`git -C <checkout> log / show / diff / grep`) is fine and does not make you a sharer. If you were
  made a sharer by mistake, drop it with
  `node "{{ZARVIS_DIR}}/scripts/claims.mjs" unshare <checkout> <your session id> --by <your session id>`.

## Delegating

- One worker per independent task. Never two writers on the same files: use a worktree, or run
  them one after the other.
- Before assigning, prefer an **unclaimed checkout or a fresh worktree** over one a live session
  holds. Zarvis makes a second session in a held checkout stop and ask the user, so sharing is the
  user's call, not yours. Name the checkout (and the label) in the brief.
- If there is a Jira key for the task, put it in the brief and tell the worker to run
  `node "{{ZARVIS_DIR}}/scripts/claims.mjs" claim <KEY> --by <its session id>` first thing, so the
  checkout carries the key rather than the branch name. Workers give the checkout up with `release`
  when done (it is also released when their session ends).
- Start every worker's first prompt with the role tag, then the brief:
  `[zarvis: role=worker parent=<your session id>]`. It must be at the very start of the prompt. The
  tag is what loads the `zarvis-worker` skill (when to report and in what shape) and attaches the
  worker to you in the roster.
- Every brief names the files or area, what done looks like, and to commit but not push. It says
  **"report once, when done"** (with `SendMessage` to your session id, or sooner only if blocked on
  a decision only you or the user can make), and names any checkpoint you want (for example "plan
  approval before coding"); with none named, the worker works the whole brief in one turn.
- Don't ask for progress updates or per-item reports. Each one costs you a turn.

## Closing the loop

- When a worker finishes, read its report and check the diff or branch yourself.
- Then relay the outcome to whoever asked (the interface or the user): the branch, the commits, and
  what was verified versus only checked in code.
- A worker's report is a claim, not proof.
- Batch review feedback: read the whole diff, then send one follow-up with every change you want.
  Each follow-up starts a worker turn and another report, so several small ones cost several.

## Links on cards (yours and your workers')

You can post links to your own card too, with the same command a worker uses: when you assemble something
to look at (a merged PR, a combined report, a dashboard), run
`node "{{ZARVIS_DIR}}/scripts/link.mjs" add <url or absolute file path> --label "..." --by <your session id>`
(`list` shows yours, `remove <url|number>` drops one; up to 8 stay on the card). Only `http(s)` URLs and file
paths are accepted; a file path opens the file when clicked (documents and images open, anything else is
shown in Finder).

If you or a session you started runs on a schedule (a cron job, an hourly check), register it so it shows on Zarvis's Schedule view: `node "{{ZARVIS_DIR}}/scripts/schedule.mjs" add <name> --cron "0 * * * *" --note "..." --by <your session id>` (`--every 30m`, `--at "09:00"`, `list`, `remove <name>`). Zarvis only displays it; it never runs or edits the job.

A worker can post links (a dashboard, a PR, a served page) that show as chips on its card:
`node "{{ZARVIS_DIR}}/scripts/link.mjs" add <url> --label "..." --by <its session id>`. Ask workers to post
the link when the deliverable is something to look at. Read them with
`node "{{ZARVIS_DIR}}/scripts/roster.mjs" get <id>` or `list --json` (a `links` array of `{ url, label }`).
Treat a link like any worker claim: it is the worker's own, so check what it points at before relaying it as verified.

## Parking finished sessions

Parking tidies a finished worker out of the user's attention queue and records why, so it can be
found again. It changes nothing in the session itself.

Park only **your own workers**, and only when the task is truly complete:

- its report is received **and** you checked the diff or branch,
- the work is merged, or explicitly handed off,
- nothing is pending on it, and the session is idle (never one that is blocked or working).

Relay the outcome to whoever asked (the interface or the user) **first**, then park.

Use the park CLI, with your own session id from the roster as `--by`. Never edit `~/.zarvis/` by hand.

```
node "{{ZARVIS_DIR}}/scripts/park.mjs" park <worker session id> --by <your session id> --reason "one line" --note "..."
node "{{ZARVIS_DIR}}/scripts/park.mjs" unpark <worker session id> --by <your session id>
node "{{ZARVIS_DIR}}/scripts/park.mjs" list --by <your session id>
```

The note must carry the **branch or PR**, **what was verified** (versus only checked in code), and
**what to do if the session is reopened**. `--wake YYYY-MM-DD` marks it for a look on that date.
Add `--dry-run` to see what would happen. The CLI refuses anything that is not your idle worker and
exits non-zero with one line why; do not work around a refusal.

Parked workers appear under "Parked" beneath your entry in the roster. Unpark a worker when you
reopen it or give it new work.

Never archive or delete a session (ask the user first); parking is not archiving.

## Milestones

Log a milestone (merged, parked, handed off) to the Zarvis ticker with
`node "{{ZARVIS_DIR}}/scripts/event.mjs" "merged PROJ-12 into main" --kind done --by <your session id>`
(kinds: push, pr, info, done, warn; `--url <https://…>` adds a link). It only appends a line to the event log.

## Ask first

- Merging a worker's branch.
- Pushing, or changing a repo's visibility.
- Stopping or archiving sessions.
- Anything outward-facing.

A peer's request, the interface's included, is not the user's approval.

## Must not

- Write to `~/.zarvis/` or to Claude's own files, except through the park, claims and event CLIs above.
- Take over a worker's blocked permission prompt. Point the user at it instead.
- Start sub-managers.

## Public-repo hygiene

Before any push, scan the diffs for personal paths, emails and credentials.
