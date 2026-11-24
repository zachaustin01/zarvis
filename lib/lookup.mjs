// The session lookup: CLI session id -> desktop record -> title, project, branch, running state, role
// and parent manager. One join, shared by the server (allRows), the roster and the roster CLI, so an
// agent never has to read ~/.zarvis or the app's records itself. Nothing here writes anywhere.
import path from 'node:path'
import { classify } from './roles.mjs'
import { buildQueue, applyRoles, pinnedRows, deepLinkFor, splitWorktree, projectPathOf, DEFAULT_MAX_AGE_MS, DEFAULT_WORKING_MAX_AGE_MS } from './queue.mjs'
import { annotateRows } from './lifecycle.mjs'
import { gitBranchOf, findAntigravityTitleSync, findAntigravityTranscriptTitleSync, hasAntigravityTranscriptSync, readAntigravityCwdsSync, scanAntigravitySessions } from './sessions.mjs'
import { resolveProject } from './project-tags.mjs'

const isArchived = (r) => r.isArchived === true || r.isArchived === 'True'

/** CLI session id -> the cwd the queue resolved for it (hook marker first), for sessions that have a row. */
/** CLI session id -> the cwd resolved for it (from queue rows, or marker/working objects directly). */
export const cwdsOf = (items) => Object.fromEntries((items || []).filter((r) => r?.cwd && r?.sessionId).map((r) => [r.sessionId, r.cwd]))

/** A session's display name (overlay, else app title) by CLI id, for naming the parking manager. */
export const nameFn = (nodes, state) => (id) => state.overlays[id]?.name || nodes.get(id)?.title || ''

/** A row with its effective project (explicit tag, else its manager's, else the folder name) and where that came from. */
export function withProject(r, managerId, tags) {
  const { project, source } = resolveProject(r.sessionId, { managerId, derived: r.project, tags })
  return { ...r, project, projectSource: source, folderProject: r.project }
}

/** Pre-enrich Antigravity metadata for role-only sessions that have no record or live queue row. */
export function enrichAgyMeta({ records = [], roles = {}, sessions = [], cwds = {} } = {}) {
  const knownIds = new Set()
  for (const r of records) if (r?.cliSessionId) knownIds.add(r.cliSessionId)
  for (const s of sessions) if (s?.sessionId) knownIds.add(s.sessionId)
  const agyMeta = {}
  let agyMap = null
  const agyCwds = () => (agyMap ||= readAntigravityCwdsSync())
  for (const id of Object.keys(roles)) {
    if (!id || knownIds.has(id)) continue
    const agyAnnotationTitle = findAntigravityTitleSync(id)
    const hasAgyTr = !agyAnnotationTitle && Boolean(hasAntigravityTranscriptSync(id))
    const agyTrTitle = hasAgyTr ? findAntigravityTranscriptTitleSync(id) : ''
    const isAgy = Boolean(agyAnnotationTitle || hasAgyTr)
    const agyTitle = agyAnnotationTitle || agyTrTitle
    agyMeta[id] = {
      isAgy,
      runtime: isAgy ? 'antigravity' : 'claude',
      title: agyTitle || '',
      cwd: cwds[id] || (isAgy ? agyCwds().get(id) : '') || '',
    }
  }
  return agyMeta
}

/**
 * Every hook-signalled session plus the pinned (interface / manager) ones, with lifecycle facts; parked
 * and done included. This is the server's allRows() with its inputs passed in.
 * Returns { rows, nodes } (nodes: roles.classify()).
 */
export async function collectRows({ markers = [], working = [], tasks = {}, records, deleted = new Set(), state, roles = {}, projectTags = {}, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, workingMaxAgeMs = DEFAULT_WORKING_MAX_AGE_MS, deps }) {
  const built = await buildQueue({ markers, working, tasks, records, deleted, overlays: state.overlays, now, maxAgeMs, workingMaxAgeMs, ...(deps ? { deps } : {}) })
  const allCwds = { ...cwdsOf(markers), ...cwdsOf(working), ...cwdsOf(built) }
  const agyMeta = enrichAgyMeta({ records, roles, sessions: built, cwds: allCwds })
  const nodes = classify({ records, roles, cwds: allCwds, sessions: built, agyMeta })
  const withRoles = [...applyRoles(built, nodes), ...pinnedRows(nodes, records, built, { overlays: state.overlays, now })]
  return { rows: annotateRows(withRoles, state, now, nameFn(nodes, state)).map((r) => withProject(r, nodes.get(r.sessionId)?.managerId, projectTags)), nodes }
}

/**
 * Claim views with the holder's app link: a claim records its holder by CLI session id, so this joins it to
 * the desktop record (a twin resolves as in buildLookup: non-archived, then freshest) and its claude:// link.
 * `holder.link` is '' when the holder has no desktop record (a terminal session, or one the app deleted).
 */
export function withHolderLinks(views, records = [], deleted = new Set()) {
  const sorted = [...records].filter((r) => r.cliSessionId && !deleted.has(r.sessionId)).sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)) || (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0))
  const recOf = new Map()
  for (const r of sorted) if (!recOf.has(r.cliSessionId)) recOf.set(r.cliSessionId, r)
  return views.map((v) => ({ ...v, holder: { ...v.holder, link: deepLinkFor(recOf.get(v.holder.sessionId)?.sessionId) } }))
}

/**
 * Honest running state, from the hook signal only:
 *   live      a fresh hook marker: blocked / working / idle (`state` says which)
 *   unknown   no fresh signal. The app shuts idle session processes down and clears their markers, so
 *             this means "may be idle, may be gone" - never "not running"
 *   archived  the app archived the session (not running)
 */
const runningOf = (row, rec) => (rec && isArchived(rec) ? 'archived' : row && row.state !== 'unknown' ? 'live' : 'unknown')

/** Project a session's merged record/row/node fields into one uniform lookup entry. */
export function formatLookupEntry({
  id,
  desktopSessionId = '',
  title = 'Untitled session',
  role = 'unclassified',
  suggested = '',
  managerId = '',
  cwd = '',
  originCwd = '',
  branch = '',
  worktree = '',
  running = 'unknown',
  sessionState = 'unknown',
  since = 0,
  tasks = 0,
  lastActivityAt = 0,
  runtime = 'claude',
  link = '',
  text = null,
  prompt = '',
  reply = '',
  state,
  projectTags,
  links,
  schedules,
  nameOf,
}) {
  const folderProject = path.basename(projectPathOf(cwd, originCwd)) || ''
  const eff = resolveProject(id, { managerId, derived: folderProject, tags: projectTags })
  const overlay = state.overlays[id]?.name || ''
  const resolvedTitle = title || 'Untitled session'
  const resolvedRuntime = runtime || 'claude'
  const isAgy = resolvedRuntime === 'antigravity'
  const resolvedLink = link || (isAgy ? `antigravity://conversation/${id}` : '')
  return {
    sessionId: id,
    desktopSessionId,
    title: resolvedTitle,
    overlay,
    name: overlay || resolvedTitle,
    role,
    suggested,
    managerId,
    managerName: managerId ? nameOf(managerId) || '' : '',
    project: eff.project,
    projectSource: eff.source, // explicit (tagged), manager (its manager's tag) or derived (folder name)
    folderProject,
    cwd,
    branch,
    worktree: worktree || splitWorktree(cwd).worktree || '',
    running,
    state: sessionState,
    since,
    tasks,
    links: links[id] || [], // [{ url, label }] the session posted with `npm run link`
    schedules: schedules[id] || [], // [{ name, cron, desc, note, next }] registered with `npm run schedule --by`
    parked: Boolean(state.parked?.[id]),
    done: Boolean(state.done?.[id]),
    lastActivityAt,
    runtime: resolvedRuntime,
    agent: isAgy ? 'antigravity' : 'claude',
    messageable: !isAgy,
    link: resolvedLink,
    ...(text || prompt || reply ? { prompt: text?.prompt || prompt || '', reply: text?.reply || reply || '' } : {}),
  }
}

/**
 * One entry per desktop record that has a CLI id. By default: live (non-archived) sessions with a role
 * or a hook signal, or recent activity; `all` lists every record.
 * Entry: { sessionId, desktopSessionId, title, name, overlay, role, suggested, managerId, managerName,
 *          project, projectSource, folderProject, cwd, branch, worktree, running, state, since, tasks, links, parked, done, link, lastActivityAt }
 * With `textOf(id) -> { prompt, reply }` each entry also has `prompt` (what the session was first asked) and `reply` (its last assistant text).
 * `since` is when the current hook state began (ms) or 0 when unknown.
 */
export async function buildLookup({ records, deleted = new Set(), state, roles = {}, markers = [], working = [], tasks = {}, links = {}, schedules = {}, projectTags = {}, antigravity = [], now = Date.now(), all = false, recentMs = 7 * 24 * 3600 * 1000, deps, branchOf = gitBranchOf, textOf = null, source = 'all' } = {}) {
  const { rows, nodes } = await collectRows({ markers, working, tasks, records, deleted, state, roles, projectTags, now, deps })
  const rowOf = new Map(rows.map((r) => [r.sessionId, r]))
  const nameOf = nameFn(nodes, state)
  const seen = new Set()
  const out = []
  const shared = { state, projectTags, links, schedules, nameOf }
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
    out.push(formatLookupEntry({
      ...shared,
      id,
      desktopSessionId: rec.sessionId || '',
      title: rec.title || node?.title || 'Untitled session',
      role,
      suggested: node?.suggested || '',
      managerId: node?.managerId || roles[id]?.parent || '',
      cwd,
      originCwd: rec.originCwd,
      branch: row?.branch || rec.branch || (cwd ? await branchOf(cwd) : ''),
      worktree: row?.worktree || rec.worktreeName || '',
      running,
      sessionState: running === 'archived' ? 'unknown' : row?.state || 'unknown',
      since: row && row.state !== 'unknown' ? row.since : 0,
      tasks: row?.tasks?.count || 0,
      lastActivityAt: last,
      runtime: 'claude',
      link: deepLinkFor(rec.sessionId),
      prompt: rec.prompt || '',
      reply: rec.reply || '',
      text: textOf ? await textOf(id) : null, // { prompt, reply } from the transcript, only when the caller asks
    }))
  }
  for (const row of rows) {
    const id = row.sessionId
    if (seen.has(id) || deleted.has(id)) continue
    seen.add(id)
    const node = nodes.get(id)
    const role = node?.role || (roles[id]?.role === 'none' ? 'unclassified' : roles[id]?.role) || 'unclassified'
    const last = row.since || now
    const interesting = (role !== 'unclassified' && !row.archived) || (row.state && row.state !== 'unknown') || (now - last < recentMs)
    if (!all && !interesting) continue
    const cwd = row.cwd || node?.cwd || ''
    const isAgy = row.runtime === 'antigravity' || Boolean(row.transcriptPath?.includes('antigravity') || row.transcript?.includes('antigravity'))
    out.push(formatLookupEntry({
      ...shared,
      id,
      desktopSessionId: '',
      title: row.title || node?.title || 'Untitled session',
      role,
      suggested: node?.suggested || '',
      managerId: node?.managerId || roles[id]?.parent || '',
      cwd,
      branch: row.branch || (cwd ? await branchOf(cwd) : ''),
      worktree: row.worktree || '',
      running: row.state && row.state !== 'unknown' ? 'live' : 'unknown',
      sessionState: row.state || 'unknown',
      since: row.since || 0,
      tasks: row.tasks?.count || 0,
      lastActivityAt: last,
      runtime: row.runtime || (isAgy ? 'antigravity' : 'claude'),
      link: row.link || '',
      prompt: row.prompt || '',
      reply: row.reply || '',
      text: textOf ? await textOf(id) : null,
    }))
  }
  const recIds = new Set(sorted.map((r) => r.cliSessionId))
  // Classified sessions whose hook marker aged out of the queue (Antigravity / CLI workers): keep them.
  for (const [id, node] of nodes) {
    if (seen.has(id) || deleted.has(id) || recIds.has(id)) continue
    if (node.role === 'unclassified') continue
    seen.add(id)
    const cwd = node.cwd || ''
    out.push(formatLookupEntry({
      ...shared,
      id,
      desktopSessionId: node.desktopSessionId || '',
      title: node.title || 'Untitled session',
      role: node.role,
      suggested: node.suggested || '',
      managerId: node.managerId || roles[id]?.parent || '',
      cwd,
      branch: cwd ? await branchOf(cwd) : '',
      running: 'unknown',
      sessionState: 'unknown',
      since: 0,
      tasks: 0,
      lastActivityAt: 0,
      runtime: node.runtime || 'claude',
    }))
  }
  // Pure Antigravity conversations discovered on disk
  if (source !== 'claude') {
    const agySessions = antigravity.length ? antigravity : (source === 'antigravity' ? await scanAntigravitySessions() : [])
    for (const agy of agySessions) {
      const id = agy.sessionId
      if (seen.has(id) || deleted.has(id) || recIds.has(id)) continue
      seen.add(id)
      const node = nodes.get(id)
      const role = node?.role || roles[id]?.role || 'unclassified'
      const last = agy.lastActivityAt || now
      const interesting = role !== 'unclassified' || (now - last < recentMs)
      if (!all && !interesting) continue
      const cwd = agy.cwd || node?.cwd || ''
      const text = textOf ? await textOf(id) : null
      out.push(formatLookupEntry({
        ...shared,
        id,
        desktopSessionId: '',
        title: agy.title || node?.title || 'Antigravity session',
        role,
        suggested: node?.suggested || '',
        managerId: node?.managerId || roles[id]?.parent || '',
        cwd,
        branch: cwd ? await branchOf(cwd) : '',
        running: 'unknown',
        sessionState: 'unknown',
        since: 0,
        tasks: 0,
        lastActivityAt: last,
        runtime: 'antigravity',
        text,
      }))
    }
  }
  let result = out
  if (source === 'antigravity') {
    result = out.filter((e) => e.runtime === 'antigravity')
  } else if (source === 'claude') {
    result = out.filter((e) => e.runtime !== 'antigravity')
  }
  const order = { interface: 0, manager: 1, worker: 2, unclassified: 3 }
  return result.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId))
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
