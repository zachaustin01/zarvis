// Pure project grouping / filtering for the front end (also imported by the tests).
// A "row" is a queue row or a tree node: { project, role, state, parked, children? }.

const needsYou = (r) => r.state === 'blocked' && !r.parked

/** Projects present, with counts from `rows` (hook-signalled sessions) and any extra names (counts 0). */
export function projectsOf(rows, extraNames = []) {
  const map = new Map()
  const get = (p) => map.get(p) || map.set(p, { project: p, blocked: 0, working: 0, total: 0 }).get(p)
  for (const r of rows) {
    if (!r.project || r.role === 'interface') continue // the interface belongs to no project filter
    const e = get(r.project)
    e.total++
    if (needsYou(r)) e.blocked++
    else if (r.state === 'working') e.working++
  }
  for (const n of extraNames) if (n) get(n)
  return [...map.values()].sort((a, b) => a.project.localeCompare(b.project))
}

/** Queue role filters: managers or workers only ('' = every role). */
export const ROLE_FILTERS = ['manager', 'worker']

/** Pressing a role key again turns its filter off; a different one switches to it. */
export const toggleRole = (current, role) => (ROLE_FILTERS.includes(role) && role !== current ? role : '')

/** `role` as a stored filter value: anything unknown means no filter. */
export const resolveRole = (v) => (ROLE_FILTERS.includes(v) ? v : '')

const shown = (r, project, role) => r.role === 'interface' || ((!project || r.project === project) && (!role || r.role === role))

/** Rows in `project` ('' = all) and with `role` ('' = any); the interface session is always kept. */
export const filterRows = (rows, project, role = '') => (project || role ? rows.filter((r) => shown(r, project, role)) : rows)

/** Blocked sessions the filters hide: never hide them silently. */
export const hiddenBlocked = (rows, project, role = '') => (project || role ? rows.filter((r) => !shown(r, project, role) && needsYou(r)).length : 0)

/** The tree restricted to `project`: a manager stays when it or any worker is in it. */
export function filterTreeByProject(t, project) {
  if (!project) return t
  const hit = (n) => n.project === project
  return {
    interface: t.interface,
    managers: t.managers.filter((m) => hit(m) || m.children.some(hit)).map((m) => ({ ...m, children: m.children.filter((c) => hit(c) || hit(m)) })),
    orphans: t.orphans.filter(hit),
    unclassified: t.unclassified.filter(hit),
  }
}

/** Next filter value cycling All -> each project -> All. An unknown `current` counts as All. */
export function cycleProject(names, current, dir = 1) {
  const list = ['', ...names]
  const i = Math.max(0, list.indexOf(current))
  return list[(i + dir + list.length) % list.length]
}

/** A stable hue (0-359) per project name, for its colour tag. */
export function projectHue(name) {
  let h = 0
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

/**
 * The chip set: projects with a queue row (a hook signal), plus parked sessions' projects. Sessions the
 * hook has never seen, and the interface, add no chip, so the set is the same whichever view was opened.
 */
export function chipProjects(rows, nodes = []) {
  const extra = nodes.filter((n) => n.role !== 'interface' && (n.parked || (n.state && n.state !== 'unknown'))).map((n) => n.project)
  return projectsOf(rows, extra)
}

/** The remembered project if it has a chip, else All. Callers drop a remembered one that fails this. */
export const resolveProject = (remembered, chips) => (chips.some((c) => c.project === remembered) ? remembered : '')

/** Parked (not done) sessions the project filter hides. */
export const hiddenParked = (nodes, project) => (project ? nodes.filter((n) => n.parked && !n.done && n.role !== 'interface' && n.project !== project).length : 0)

/** "just now", "5m ago", "2h ago", "3d ago". */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
