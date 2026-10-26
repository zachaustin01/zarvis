// Park / done lifecycle. Tool-owned (state.json); pure helpers shared by the queue and the role tree.
//   parked: { parkedAt, reason, wake: { type: 'none'|'date', value }, handoffNote }
//   done:   true
// Nothing here writes anywhere or touches Claude's files.

export const WAKE_TYPES = ['none', 'date']
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local midnight of a `YYYY-MM-DD` wake date, or NaN when it is not a real calendar date. */
export function wakeTime(value) {
  const m = DATE.exec(String(value ?? ''))
  if (!m) return NaN
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(y, mo - 1, d)
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : NaN
}

/** A parked session whose date wake condition has passed. */
export function isWakeReady(parked, now = Date.now()) {
  return Boolean(parked && parked.wake?.type === 'date' && wakeTime(parked.wake.value) <= now)
}

/** The lifecycle facts for one session: { parked: object|null, done, wakeReady }. */
export function lifecycleOf(state, sessionId, now = Date.now()) {
  const parked = state.parked?.[sessionId] || null
  return { parked, done: Boolean(state.done?.[sessionId]), wakeReady: isWakeReady(parked, now) }
}

/** Annotate queue rows with their lifecycle facts (nothing is dropped). */
export function annotateRows(rows, state, now = Date.now()) {
  return rows.map((r) => ({ ...r, ...lifecycleOf(state, r.sessionId, now) }))
}

/**
 * The "Needs you" queue view of annotated rows: done sessions are hidden; parked ones leave unless
 * they are blocked (still shown, marked) or their wake date has passed (back, marked wake-ready).
 */
export function visibleRows(rows) {
  return rows.filter((r) => !r.done && (!r.parked || r.state === 'blocked' || r.wakeReady))
}

/** The roster lists live work only: the tree without done sessions. */
export function hideDone(tree) {
  const keep = (n) => !n.done
  return {
    interface: tree.interface.filter(keep),
    managers: tree.managers.filter(keep).map((m) => ({ ...m, children: m.children.filter(keep) })),
    orphans: tree.orphans.filter(keep),
    unclassified: tree.unclassified.filter(keep),
  }
}
