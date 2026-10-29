// The cost model: usage snapshots (lib/usage.mjs) x prices (lib/pricing.mjs) x session facts -> per-project numbers.
// Pure: no I/O. Dollars are an API-equivalent estimate (what the tokens would cost at API list prices), never a bill.
import path from 'node:path'
import { E } from './usage.mjs'
import { priceFor, costOf, tierFor, baseModelId } from './pricing.mjs'
import { projectPathOf } from './queue.mjs'
import { resolveProject } from './project-tags.mjs'

export const RANGES = ['today', '7d', '30d', 'all']
export const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
const addTokens = (a, b) => { for (const k in a) a[k] += b[k] || 0 }
export const totalTokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

/** Local calendar day (YYYY-MM-DD) of a timestamp. */
export function dayOf(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local midnight at the start of the range (0 for `all`): `today` = since midnight, `7d` = today and the 6 days before. */
export function rangeStart(range, now = Date.now()) {
  const days = { today: 1, '7d': 7, '30d': 30 }[range]
  if (!days) return 0
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime()
}

export const normalizeRange = (r) => (RANGES.includes(r) ? r : '7d')

/** Every local day from the range start through today (for `all`, from the first message), oldest first. */
export function daysIn(start, now) {
  const out = []
  const d = new Date(start)
  const end = dayOf(now)
  for (let i = 0; i < 4000; i++) {
    const k = dayOf(d)
    out.push(k)
    if (k >= end) break
    d.setDate(d.getDate() + 1)
  }
  return out
}

const bucket = () => ({ cost: 0, tokens: ZERO(), unpricedTokens: 0 })
const roleGroup = (role) => (role === 'manager' || role === 'worker' ? role : 'other')

const newGroup = (key, name, extra = {}) => ({ key, name, ...extra, ...bucket(), messages: 0, sessionIds: new Set(), models: new Map(), roles: { manager: { ...bucket(), sessions: new Set() }, worker: { ...bucket(), sessions: new Set() }, other: { ...bucket(), sessions: new Set() } }, days: new Map(), sess: new Map() })

/**
 * @param usage     lib/usage.mjs snapshot: [{ sessionId, cwd, entries }]
 * @param sessions  Map or object: CLI session id -> { name, role, managerId, project (derived folder name), cwd, desktopSessionId, parked, done }
 * @param opts      { prices, tags, range, now, project, manager }
 *
 * Returns { range, since, now, totals, projects: [...], managers: [...], unpriced: [{ model, tokens, messages }], approx: [{ model, as }] }.
 * Group row (projects and managers share the shape): { key, name, cost, tokens, totalTokens, unpricedTokens, messages, sessions,
 *   models: [{ model, cost, tokens, priced, match }], roles: { manager, worker, other: { cost, totalTokens, sessions } },
 *   days: [{ day, cost }], top: [session rows by cost] }. A project row also has `project` and `explicit`; a manager row `managerId`
 *   ('' for the two buckets), `kind` ('manager' | 'interface' | 'unclassified' | 'unmanaged': workers with no manager) and `projects`. A manager's row is its own spend plus every worker attached to it, parked ones included.
 */
export function buildCosts(usage, sessions, { prices, tags = {}, range = '7d', now = Date.now(), project = '', manager = '' } = {}) {
  range = normalizeRange(range)
  const since = rangeStart(range, now)
  const metaOf = sessions instanceof Map ? (id) => sessions.get(id) : (id) => sessions[id]
  const projects = new Map()
  const managers = new Map()
  const totals = { ...bucket(), messages: 0, sessions: 0, roles: { manager: 0, worker: 0, other: 0 } }
  const unpriced = new Map()
  const approx = new Map()
  const dayTotals = new Map()
  let firstDay = ''
  const wantMgr = String(manager).trim().toLowerCase()

  for (const u of usage) {
    const meta = metaOf(u.sessionId)
    const derived = meta?.project || path.basename(projectPathOf(meta?.cwd || u.cwd || '', '')) || 'unknown'
    const eff = resolveProject(u.sessionId, { managerId: meta?.managerId || '', derived, tags })
    if (project && eff.project.toLowerCase() !== project.toLowerCase()) continue
    const role = meta?.role || 'unclassified'
    // The manager a session's spend rolls up to: itself, or the manager it is attached to; '' when it has none.
    const mid = role === 'manager' ? u.sessionId : role === 'worker' ? meta?.managerId || '' : ''
    // Rows are managers, then the interface and unclassified sessions as rows of their own; workers tagged to no manager
    // are kept apart as `unmanaged` (the view shows them as a chip).
    const kind = mid ? 'manager' : role === 'worker' ? 'unmanaged' : role === 'interface' ? 'interface' : 'unclassified'
    const gkey = mid || `~${kind}`
    const mname = mid ? metaOf(mid)?.name || `manager ${mid.slice(0, 8)}` : kind === 'unmanaged' ? 'Unmanaged workers' : kind === 'interface' ? 'Interface' : 'Unclassified sessions'
    if (wantMgr && mid.toLowerCase() !== wantMgr && mname.toLowerCase() !== wantMgr && !(mid && mid.toLowerCase().startsWith(wantMgr))) continue
    const sess = new Map() // group -> the session row being filled
    for (const e of u.entries) {
      const ts = e[E.ts]
      if (ts < since) continue
      const model = e[E.model]
      const t = { input: e[E.input], output: e[E.output], cacheRead: e[E.cacheRead], cacheWrite5m: e[E.cw5], cacheWrite1h: e[E.cw1] }
      const n = totalTokens(t)
      if (!n) continue
      const day = dayOf(ts || now)
      if (!firstDay || day < firstDay) firstDay = day
      const hit = priceFor(model, prices)
      let cost = 0
      if (hit) {
        cost = costOf(t, tierFor(hit.price, t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h))
        if (hit.match === 'family') approx.set(baseModelId(model), hit.key)
      } else {
        const un = unpriced.get(baseModelId(model)) || { model: baseModelId(model), tokens: 0, messages: 0 }
        un.tokens += n
        un.messages++
        unpriced.set(un.model, un)
      }
      const rg = roleGroup(role)
      for (const [map, key, name, extra] of [[projects, eff.project, eff.project, { project: eff.project }], [managers, gkey, mname, { managerId: mid, kind }]]) {
        let g = map.get(key)
        if (!g) map.set(key, (g = newGroup(key, name, { ...extra, explicit: false, projectNames: new Set() })))
        let sr = sess.get(g)
        if (!sr) {
          if (!g.sess.has(u.sessionId)) g.sess.set(u.sessionId, { sessionId: u.sessionId, desktopSessionId: meta?.desktopSessionId || '', name: meta?.name || '', role, source: eff.source, project: eff.project, parked: !!meta?.parked, done: !!meta?.done, ...bucket(), messages: 0, last: 0 })
          sess.set(g, (sr = g.sess.get(u.sessionId)))
        }
        for (const b of [g, sr, g.roles[rg]]) {
          b.cost += cost
          addTokens(b.tokens, t)
          if (!hit) b.unpricedTokens += n
        }
        g.messages++
        sr.messages++
        sr.last = Math.max(sr.last, ts)
        g.sessionIds.add(u.sessionId)
        g.roles[rg].sessions.add(u.sessionId)
        g.projectNames.add(eff.project)
        if (eff.source === 'explicit') g.explicit = true
        const m = g.models.get(model) || g.models.set(model, { model, cost: 0, tokens: ZERO(), priced: !!hit, match: hit?.match || '' }).get(model)
        m.cost += cost
        addTokens(m.tokens, t)
        g.days.set(day, (g.days.get(day) || 0) + cost)
      }
      for (const b of [totals]) {
        b.cost += cost
        addTokens(b.tokens, t)
        if (!hit) b.unpricedTokens += n
      }
      totals.messages++
      dayTotals.set(day, (dayTotals.get(day) || 0) + cost)
    }
  }

  const dayList = daysIn(range === 'all' ? new Date(`${firstDay || dayOf(now)}T00:00:00`).getTime() : since, now)
  const finish = (map) =>
    [...map.values()]
      .map((g) => ({
        key: g.key,
        name: g.name,
        ...(g.project !== undefined ? { project: g.project } : {}),
        ...(g.managerId !== undefined ? { managerId: g.managerId, kind: g.kind } : {}),
        explicit: g.explicit,
        projects: [...g.projectNames].sort(),
        cost: g.cost,
        tokens: g.tokens,
        totalTokens: totalTokens(g.tokens),
        unpricedTokens: g.unpricedTokens,
        messages: g.messages,
        sessions: g.sessionIds.size,
        models: [...g.models.values()].map((m) => ({ ...m, totalTokens: totalTokens(m.tokens) })).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens),
        roles: Object.fromEntries(Object.entries(g.roles).map(([k, r]) => [k, { cost: r.cost, totalTokens: totalTokens(r.tokens), unpricedTokens: r.unpricedTokens, sessions: r.sessions.size }])),
        days: dayList.map((day) => ({ day, cost: g.days.get(day) || 0 })),
        top: [...g.sess.values()].map((x) => ({ ...x, totalTokens: totalTokens(x.tokens) })).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens),
      }))
      .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens || a.name.localeCompare(b.name))
  const rows = finish(projects)
  totals.sessions = new Set(rows.flatMap((r) => r.top.map((x) => x.sessionId))).size
  for (const k of ['manager', 'worker', 'other']) totals.roles[k] = rows.reduce((a, r) => a + r.roles[k].cost, 0)
  return {
    range,
    since,
    now,
    totals: { cost: totals.cost, tokens: totals.tokens, totalTokens: totalTokens(totals.tokens), unpricedTokens: totals.unpricedTokens, messages: totals.messages, sessions: totals.sessions, roles: totals.roles },
    days: dayList.map((day) => ({ day, cost: dayTotals.get(day) || 0 })),
    projects: rows,
    managers: finish(managers),
    unpriced: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens),
    approx: [...approx].map(([model, as]) => ({ model, as })),
  }
}
