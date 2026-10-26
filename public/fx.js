// Pure state for the HUD effects (fuse, ambient glow, tab title, ticker). No DOM in here, so it is unit-tested.

/** A blocked row that counts toward "needs you": blocked (permission or question) and not parked. */
export const needsYou = (r) => r.state === 'blocked' && !r.parked

/**
 * Wait-fuse inputs for one row: `p` is the elapsed fraction of the overdue window (0..1) and `d` the
 * negative animation delay that starts a CSS animation at that point, so it survives list redraws.
 */
export function fuseVars(since, now, overdueMs) {
  const e = Math.min(overdueMs, Math.max(0, now - since))
  return { p: Number((e / overdueMs).toFixed(3)), d: `-${(e / 1000).toFixed(1)}s` }
}

/** The ambient edge glow: '' (nothing blocked), 'blocked' (amber) or 'overdue' (red). */
export function glowState(rows, now, overdueMs) {
  let state = ''
  for (const r of rows) {
    if (!needsYou(r)) continue
    if (now - r.since > overdueMs) return 'overdue'
    state = 'blocked'
  }
  return state
}

/** Tab-level attention state from the rows: how many need you and whether any wait is overdue. */
export function attention(rows, now, overdueMs) {
  const blocked = rows.filter(needsYou)
  return { count: blocked.length, overdue: blocked.some((r) => now - r.since > overdueMs) }
}

/** "(3!) Zarvis": the count in parentheses, `!` once overdue; plain "Zarvis" when nothing needs you. */
export const tabTitle = ({ count, overdue }) => (count ? `(${count}${overdue ? '!' : ''}) Zarvis` : 'Zarvis')

/** What the favicon shows. `key` changes only when the picture would, so the canvas is redrawn rarely. */
export function faviconState({ count, overdue }) {
  const color = !count ? 'idle' : overdue ? 'red' : 'amber'
  const label = count > 9 ? '9+' : count ? String(count) : ''
  return { color, label, key: `${color}:${label}` }
}

/** What the ticker remembers about each session between pushes. */
export const snapshot = (rows) => new Map(rows.map((r) => [r.sessionId, { state: r.state, parked: !!r.parked }]))

/**
 * State transitions between the last snapshot and `rows`: arrived, blocked, unblocked (resumed), finished
 * and parked. `prev` null (the first load) yields nothing: that is not news. Each event: { kind, id, text }.
 */
export function diffEvents(prev, rows) {
  if (!prev) return []
  const out = []
  for (const r of rows) {
    const p = prev.get(r.sessionId)
    const ev = (kind, text) => out.push({ kind, id: r.sessionId, text: `${r.name} ${text}` })
    if (!p) { ev('arrived', 'appeared'); continue }
    const wasBlocked = p.state === 'blocked' && !p.parked
    const isBlocked = needsYou(r)
    if (!p.parked && r.parked) ev('parked', 'parked')
    else if (!wasBlocked && isBlocked) ev('blocked', r.kind === 'question' ? 'asks a question' : `needs you${r.tool ? ` · ${r.tool}` : ''}`)
    else if (wasBlocked && !isBlocked && !r.parked) ev(r.state === 'idle' ? 'finished' : 'resumed', r.state === 'idle' ? 'finished' : 'resumed')
    else if (p.state === 'working' && r.state === 'idle') ev('finished', 'finished')
  }
  return out
}
