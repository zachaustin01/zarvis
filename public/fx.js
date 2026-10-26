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
