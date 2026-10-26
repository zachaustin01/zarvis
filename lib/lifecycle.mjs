// Park / done lifecycle. Tool-owned (state.json); pure helpers shared by the queue and the role tree.
//   parked: { parkedAt, parkedBy, reason, wake: null | { type: 'date', value }, handoffNote }
//   parkedBy is the parking manager's session id, '' when parked by hand
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

/** The lifecycle facts for one session: { parked: object|null, done, wakeReady }. `nameOf` names the parking manager. */
export function lifecycleOf(state, sessionId, now = Date.now(), nameOf = () => '') {
  const p = state.parked?.[sessionId]
  const parked = p ? { ...p, parkedByName: p.parkedBy ? nameOf(p.parkedBy) || '' : '' } : null
  return { parked, done: Boolean(state.done?.[sessionId]), wakeReady: isWakeReady(parked, now) }
}

/** Annotate queue rows with their lifecycle facts (nothing is dropped). */
export function annotateRows(rows, state, now = Date.now(), nameOf) {
  return rows.map((r) => ({ ...r, ...lifecycleOf(state, r.sessionId, now, nameOf) }))
}

/**
 * The "Needs you" queue view of annotated rows: done sessions are hidden; parked ones leave unless
 * they are blocked (still shown, marked) or their wake date has passed (back, marked wake-ready).
 */
export function visibleRows(rows) {
  return rows.filter((r) => !r.done && (!r.parked || r.state === 'blocked' || r.wakeReady))
}

const isArchivedRec = (r) => r.isArchived === true || r.isArchived === 'True'

/**
 * Parked sessions whose desktop record is archived. Classification and the queue skip archived
 * records, so without this they would vanish from the Parked view though their `parked` entry is
 * still in the state file. A session with a live (non-archived) record is not listed here: it is
 * already a normal tree node. State entries with no record at all stay out (nothing to name them by).
 * `roles`: the role registry ({ [cliSessionId]: { role, parent? } }), used only to keep a parked
 * archived worker under its manager in the roster.
 * Node: { sessionId, desktopSessionId, title, cwd, branch, role, managerId, archived: true }.
 */
export function archivedParked(records, state, roles = {}) {
  const live = new Set(records.filter((r) => r.cliSessionId && !isArchivedRec(r)).map((r) => r.cliSessionId))
  const seen = new Set()
  const out = []
  for (const r of records) {
    const id = r.cliSessionId
    if (!id || !isArchivedRec(r) || live.has(id) || seen.has(id) || !state.parked?.[id] || state.done?.[id]) continue
    seen.add(id)
    const tag = roles[id]
    const role = ['interface', 'manager', 'worker'].includes(tag?.role) ? tag.role : 'unclassified'
    out.push({
      sessionId: id,
      desktopSessionId: r.sessionId || '',
      title: r.title || 'Untitled session',
      cwd: r.cwd || r.originCwd || '',
      branch: r.branch || '',
      role,
      managerId: role === 'worker' && tag.parent && tag.parent !== id ? tag.parent : '',
      archived: true,
    })
  }
  return out
}

/** The roster lists live work only: the tree without done sessions. */
export function hideDone(tree) {
  const keep = (n) => !n.done
  return {
    interface: tree.interface.filter(keep),
    managers: tree.managers.filter(keep).map((m) => ({ ...m, children: m.children.filter(keep) })),
    orphans: tree.orphans.filter(keep),
    unclassified: tree.unclassified.filter(keep),
    ...(tree.archived ? { archived: tree.archived.filter(keep) } : {}),
  }
}
