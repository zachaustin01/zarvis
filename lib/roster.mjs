// The roster: one markdown file listing every manager and the workers attached to it, so a manager
// (an ordinary Claude session that knows nothing about Zarvis) can read who its workers are.
// Pure: takes the role tree the server builds (and the claim views), returns text. No timestamps, and
// ages only to the minute, so an unchanged roster renders identically and the server can skip the write.
import { shortPath } from './claims.mjs'

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function worker(w) {
  const where = [w.project, w.branch].filter(Boolean).join(' › ')
  return `  - ${one(w.name)} — ${w.state}${w.tasks?.count ? ` (${w.tasks.count} background task${w.tasks.count > 1 ? 's' : ''} running)` : ''}${where ? ` — ${where}` : ''}\n    session \`${w.sessionId}\`${w.desktopSessionId ? ` · app \`${w.desktopSessionId}\`` : ''}`
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10)

function parkedWorker(w) {
  const p = w.parked
  const where = [w.project, w.branch].filter(Boolean).join(' › ')
  const note = one((p.handoffNote || '').split('\n').find((l) => l.trim()))
  return (
    `  - ${one(w.name)} — parked${w.archived ? ' (archived in the app)' : ''} — ${one(p.reason)} — ${day(p.parkedAt)}${p.wake ? ` — wakes ${p.wake.value}` : ''}${where ? ` — ${where}` : ''}\n` +
    `    session \`${w.sessionId}\`${w.desktopSessionId ? ` · app \`${w.desktopSessionId}\`` : ''}${note ? `\n    note: ${note}` : ''}`
  )
}

const ago = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

function checkout(c, now) {
  const where = [c.label, c.branch && c.branch !== c.label ? c.branch : ''].filter(Boolean).join(' › ')
  const state = c.live ? 'live' : c.stale ? 'stale' : 'dead'
  const sharers = c.shared.length ? ` — shared with ${c.shared.map((s) => one(s.name)).join(', ')}` : ''
  return `  - ${shortPath(c.root)} — ${one(where)} — held by ${one(c.holder.name)} (session \`${c.holder.sessionId}\`)${sharers} — last write ${ago(now - c.holder.lastWrite)} ago — ${state}`
}

/**
 * @param tree  { interface, managers: [{...node, children}], orphans, unclassified } from the server
 * @param claims  claim views (lib/claims.mjs claimView), shown as a "Checkouts" section
 */
export function renderRoster(tree, claims = [], now = Date.now()) {
  const lines = [
    '# Zarvis roster',
    '',
    'Written by Zarvis; read-only for you. Find your own entry by its name or project, then read your workers below.',
    'Parked workers are listed apart from live ones: their state is `parked`, then the reason, the date, the session id and the first line of the handoff note.',
    'A worker marked "N background tasks running" has ended its turn but still has background commands, monitors or subagents running; it is not stuck.',
    'States: needs you (blocked on a permission prompt, or its turn ended on a question waiting for your answer), waiting on worker, working, idle, no signal (no hook has reported).',
    'To name any session by id (title, role, manager, project, branch, running state) run `npm run roster -- get <id>` or `npm run roster -- list --json` from the Zarvis clone; do not read ~/.zarvis by hand.',
    '',
  ]
  for (const i of tree.interface) lines.push(`## Interface: ${one(i.name)}`, `- session \`${i.sessionId}\`${i.desktopSessionId ? ` · app \`${i.desktopSessionId}\`` : ''}`, '')
  if (!tree.managers.length) lines.push('No managers yet.', '')
  for (const m of tree.managers) {
    lines.push(`## Manager: ${one(m.name)}`, `- session \`${m.sessionId}\`${m.desktopSessionId ? ` · app \`${m.desktopSessionId}\`` : ''}${m.project ? ` · project ${m.project}` : ''}${m.branch ? ` › ${m.branch}` : ''} · ${m.state}`)
    const live = m.children.filter((c) => !c.parked)
    // Archived parked workers are not tree children (the app archived them), but they stay listed here.
    const parked = [...m.children.filter((c) => c.parked), ...(tree.archived || []).filter((a) => a.managerId === m.sessionId)]
    lines.push(live.length ? '- workers:' : parked.length ? '- workers: none live' : '- workers: none attached', ...live.map(worker))
    if (parked.length) lines.push('- parked (finished; reopen with the app link or unpark):', ...parked.map(parkedWorker))
    lines.push('')
  }
  lines.push(
    '## Checkouts',
    'Git checkouts (worktree roots) a session is working in. A live holder owns it: do not give another worker the same checkout; use a free one or a worktree. A stale or dead claim is taken over by the next session that writes there.',
  )
  lines.push(...(claims.length ? claims.map((c) => checkout(c, now)) : ['- none claimed']), '')
  return lines.join('\n')
}
