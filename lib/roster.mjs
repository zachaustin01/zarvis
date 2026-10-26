// The roster: one markdown file listing every manager and the workers attached to it, so a manager
// (an ordinary Claude session that knows nothing about Zarvis) can read who its workers are.
// Pure: takes the role tree the server builds, returns text. Nothing volatile (no timestamps), so an
// unchanged roster renders identically and the server can skip the write.

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function worker(w) {
  const where = [w.project, w.branch].filter(Boolean).join(' › ')
  return `  - ${one(w.name)} — ${w.state}${where ? ` — ${where}` : ''}\n    session \`${w.sessionId}\`${w.desktopSessionId ? ` · app \`${w.desktopSessionId}\`` : ''}`
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10)

function parkedWorker(w) {
  const p = w.parked
  const where = [w.project, w.branch].filter(Boolean).join(' › ')
  const note = one((p.handoffNote || '').split('\n').find((l) => l.trim()))
  return (
    `  - ${one(w.name)} — parked — ${one(p.reason)} — ${day(p.parkedAt)}${p.wake ? ` — wakes ${p.wake.value}` : ''}${where ? ` — ${where}` : ''}\n` +
    `    session \`${w.sessionId}\`${w.desktopSessionId ? ` · app \`${w.desktopSessionId}\`` : ''}${note ? `\n    note: ${note}` : ''}`
  )
}

/** @param tree  { interface, managers: [{...node, children}], orphans, unclassified } from the server */
export function renderRoster(tree) {
  const lines = [
    '# Zarvis roster',
    '',
    'Written by Zarvis; read-only for you. Find your own entry by its name or project, then read your workers below.',
    'Parked workers are listed apart from live ones: their state is `parked`, then the reason, the date, the session id and the first line of the handoff note.',
    'States: needs you (blocked on a permission prompt), waiting on worker, working, idle, no signal (no hook has reported).',
    '',
  ]
  for (const i of tree.interface) lines.push(`## Interface: ${one(i.name)}`, `- session \`${i.sessionId}\``, '')
  if (!tree.managers.length) lines.push('No managers yet.', '')
  for (const m of tree.managers) {
    lines.push(`## Manager: ${one(m.name)}`, `- session \`${m.sessionId}\`${m.project ? ` · project ${m.project}` : ''}`)
    const live = m.children.filter((c) => !c.parked)
    const parked = m.children.filter((c) => c.parked)
    lines.push(live.length ? '- workers:' : parked.length ? '- workers: none live' : '- workers: none attached', ...live.map(worker))
    if (parked.length) lines.push('- parked (finished; reopen with the app link or unpark):', ...parked.map(parkedWorker))
    lines.push('')
  }
  return lines.join('\n')
}
