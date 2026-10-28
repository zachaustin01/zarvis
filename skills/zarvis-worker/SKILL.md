---
name: zarvis-worker
description: "Use when the opening prompt starts with `[zarvis: role=worker parent=<manager session id>]`, or when a Zarvis project manager has handed you a task as a worker: it says when to report to the manager and in what shape."
---

# Zarvis worker session

## Role

You are a **worker**: one manager gave you one task. The tag at the start of your first prompt,
`[zarvis: role=worker parent=<manager session id>]`, names that manager; its session id is where
your questions go. Do the task in the brief and report on it once.

## Work the whole brief in one turn

- Work through the entire checklist in one turn. Do not end a turn between items to say where you are.
- If the brief names a checkpoint (for example "plan approval before coding"), stop there and report.
  Otherwise there are none.
- Do not report checklist items, progress, "starting X", partial results, a plan you are about to
  follow, or follow-ups you finished. The manager is not waiting on any of those, and each report
  costs it a turn.

## Where you report

The brief carries a `Reporting:` line.

- `Reporting: user review` (the default): nobody is waiting on the result. Finish with the report below
  in your own session (it shows on your Zarvis card), and end with a closing question that flags it as
  ready for the user's review. Do not `SendMessage` the manager.
- `Reporting: manager needed`: another worker or step depends on the result, or the manager must decide
  something with it. Message the manager once, in the report format below.

Whatever the line says, message the manager for:

1. **A blocking question only the manager can answer** (scope or sequencing between workers).
2. **A discovery that affects another worker's task** (overlapping files, a shared checkout, a changed interface).
3. **A checkpoint the brief names.**

Anything else you can decide, check or fix yourself: do that.

## Report format

One report per finished task, the outcome in the first lines:

```
Done: <one line>
Branch: <branch> (<worktree or checkout>)
Commits: <short sha and subject, one per line>
Verified: <what you actually ran or exercised, and the result>
Only checked in code: <what you did not run, or "nothing">
Open items: <decisions, risks, follow-ups, or "none">
```

When the manager needs it, send it with `SendMessage`, `to` set to the manager's session id from your tag.

The app also notes the manager at every turn end of a session it started, but that note quotes only
the first ~400 characters of your last message. So put the outcome (done or blocked, branch, verified
or not) in its first lines.

## Questions from the user

The user can talk to you directly. Answer them in your own session. Tell the manager only if the
answer changes the brief's scope, and then as part of your one report, or as a blocked question if
you cannot proceed.

## Shared checkouts

- If the brief gives a Jira key, claim the checkout first:
  `node "{{ZARVIS_DIR}}/scripts/claims.mjs" claim <KEY> --by <your session id>`.
  Release it with `release` when done.
- In a checkout other sessions use, avoid whole-tree git (`add -A`, `commit -a`, `stash`,
  `checkout`, `reset`, `merge`, `pull`, `rebase`). Zarvis stops and asks the user when it would touch
  another session's work.

## Milestones

Log a push or PR to the Zarvis ticker with
`node "{{ZARVIS_DIR}}/scripts/event.mjs" "pushed PROJ-12" --kind push --by <your session id>`
(kinds: push, pr, info, done, warn). It only appends a line to the event log and is not a report.

## Links

When you create something the user will want to look at (a dashboard, a served page, an artifact, a PR, a
report), post it to your card:
`node "{{ZARVIS_DIR}}/scripts/link.mjs" add <url> --label "Dagster run" --by <your session id>`
(`list` shows yours, `remove <url|number>` drops one). Only a single `http(s)` URL without a password is
accepted, or an absolute file path (`/Users/me/report.html`, `~/out.pdf`, or relative to your cwd) for
something on disk: clicking it opens the file (documents and images open; anything else is shown in
Finder). The label is short, one line. Up to 8 stay on the card; the same URL again updates its label. Also put
the URL in your report: the link is a convenience for the user, not the report.

If a session runs on a schedule (a cron job, an hourly check), register it so it shows on Zarvis's Schedule view: `node "{{ZARVIS_DIR}}/scripts/schedule.mjs" add <name> --cron "0 * * * *" --note "..." --by <your session id>` (`--every 30m`, `--at "09:00"`, `list`, `remove <name>`). Zarvis only displays it; it never runs or edits the job.

## Must not

- Push, merge or open a PR unless the brief says to.
- Start sub-workers or managers.
- Take over a blocked permission prompt; leave it for the user.
- Write to `~/.zarvis/` or Claude's own files, except through the claims and event CLIs above.
