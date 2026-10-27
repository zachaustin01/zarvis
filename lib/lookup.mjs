// The session lookup: CLI session id -> desktop record -> title, project, branch, running state, role
// and parent manager. One join, shared by the server (allRows), the roster and the roster CLI, so an
// agent never has to read ~/.zarvis or the app's records itself. Nothing here writes anywhere.
import path from 'node:path'
import { classify } from './roles.mjs'
import { buildQueue, applyRoles, pinnedRows, deepLinkFor, splitWorktree, projectPathOf, DEFAULT_MAX_AGE_MS, DEFAULT_WORKING_MAX_AGE_MS } from './queue.mjs'
import { annotateRows } from './lifecycle.mjs'
import { gitBranchOf } from './sessions.mjs'

const isArchived = (r) => r.isArchived === true || r.isArchived === 'True'

/** CLI session id -> the cwd the queue resolved for it (hook marker first), for sessions that have a row. */
export const cwdsOf = (rows) => Object.fromEntries(rows.filter((r) => r.cwd).map((r) => [r.sessionId, r.cwd]))

/** A session's display name (overlay, else app title) by CLI id, for naming the parking manager. */
export const nameFn = (nodes, state) => (id) => state.overlays[id]?.name || nodes.get(id)?.title || ''

/**
 * Every hook-signalled session plus the pinned (interface / manager) ones, with lifecycle facts; parked
 * and done included. This is the server's allRows() with its inputs passed in.
 * Returns { rows, nodes } (nodes: roles.classify()).
 */
export async function collectRows({ markers = [], working = [], tasks = {}, records, deleted = new Set(), state, roles = {}, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, workingMaxAgeMs = DEFAULT_WORKING_MAX_AGE_MS, deps }) {
  const built = await buildQueue({ markers, working, tasks, records, deleted, overlays: state.overlays, now, maxAgeMs, workingMaxAgeMs, ...(deps ? { deps } : {}) })
  const nodes = classify({ records, roles, cwds: cwdsOf(built) })
  const withRoles = [...applyRoles(built, nodes), ...pinnedRows(nodes, records, built, { overlays: state.overlays, now })]
  return { rows: annotateRows(withRoles, state, now, nameFn(nodes, state)), nodes }
}

/**
 * Honest running state, from the hook signal only:
 *   live      a fresh hook marker: blocked / working / idle (`state` says which)
 *   unknown   no fresh signal. The app shuts idle session processes down and clears their markers, so
 *             this means "may be idle, may be gone" - never "not running"
 *   archived  the app archived the session (not running)
 */
const runningOf = (row, rec) => (rec && isArchived(rec) ? 'archived' : row && row.state !== 'unknown' ? 'live' : 'unknown')

/**
 * One entry per desktop record that has a CLI id. By default: live (non-archived) sessions with a role
 * or a hook signal, or recent activity; `all` lists every record.
 * Entry: { sessionId, desktopSessionId, title, name, overlay, role, suggested, managerId, managerName,
 *          project, cwd, branch, worktree, running, state, since, tasks, links, parked, done, link, lastActivityAt }
 * `since` is when the current hook state began (ms) or 0 when unknown.
 */
export async function buildLookup({ records, deleted = new Set(), state, roles = {}, markers = [], working = [], tasks = {}, links = {}, now = Date.now(), all = false, recentMs = 7 * 24 * 3600 * 1000, deps, branchOf = gitBranchOf } = {}) {
  const { rows, nodes } = await collectRows({ markers, working, tasks, records, deleted, state, roles, now, deps })
  const rowOf = new Map(rows.map((r) => [r.sessionId, r]))
  const nameOf = nameFn(nodes, state)
  const seen = new Set()
  const out = []
  // Newest record first so a twin (same CLI id) resolves to the freshest, preferring a non-archived one.
  const sorted = [...records].filter((r) => r.cliSessionId).sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)) || (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0))
  for (const rec of sorted) {
    const id = rec.cliSessionId
    if (seen.has(id) || deleted.has(rec.sessionId)) continue
    seen.add(id)
    const node = nodes.get(id)
    const row = rowOf.get(id)
    const last = Number(rec.lastActivityAt) || Number(rec.createdAt) || 0
    const role = node?.role || (roles[id]?.role === 'none' ? 'unclassified' : roles[id]?.role) || 'unclassified'
    const running = runningOf(row, rec)
    const interesting = (role !== 'unclassified' && running !== 'archived') || (row && row.state !== 'unknown') || (last && now - last < recentMs && running !== 'archived')
    if (!all && !interesting) continue
    const cwd = row?.cwd || node?.cwd || rec.cwd || ''
    const projectPath = projectPathOf(cwd, rec.originCwd)
    const branch = row?.branch || rec.branch || (cwd ? await branchOf(cwd) : '')
    const managerId = node?.managerId || roles[id]?.parent || ''
    const overlay = state.overlays[id]?.name || ''
    const title = rec.title || node?.title || 'Untitled session'
    out.push({
      sessionId: id,
      desktopSessionId: rec.sessionId || '',
      title,
      overlay,
      name: overlay || title,
      role,
      suggested: node?.suggested || '',
      managerId,
      managerName: managerId ? nameOf(managerId) || '' : '',
      project: path.basename(projectPath) || '',
      cwd,
      branch,
      worktree: row?.worktree || rec.worktreeName || splitWorktree(cwd).worktree || '',
      running,
      state: running === 'archived' ? 'unknown' : row?.state || 'unknown',
      since: row && row.state !== 'unknown' ? row.since : 0,
      tasks: row?.tasks?.count || 0,
      links: links[id] || [], // [{ url, label }] the session posted with `npm run link`
      parked: Boolean(state.parked?.[id]),
      done: Boolean(state.done?.[id]),
      lastActivityAt: last,
      link: deepLinkFor(rec.sessionId),
    })
  }
  const order = { interface: 0, manager: 1, worker: 2, unclassified: 3 }
  return out.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId))
}

/** One entry by full CLI id, the app's `local_…` id, or a unique prefix (min 6 chars) of either. */
export function findEntry(entries, id) {
  const q = String(id || '').trim()
  if (!q) return { error: 'no session id given' }
  const exact = entries.find((e) => e.sessionId === q || e.desktopSessionId === q)
  if (exact) return { entry: exact }
  const bare = q.replace(/^local_/, '')
  if (bare.length < 6) return { error: `${q} is too short to match (need 6+ characters)` }
  const hits = entries.filter((e) => e.sessionId.startsWith(bare) || e.desktopSessionId.replace(/^local_/, '').startsWith(bare))
  if (hits.length === 1) return { entry: hits[0] }
  return { error: hits.length ? `${q} is ambiguous (${hits.length} sessions)` : `${q} is not a session Zarvis can find in the app's records` }
}
