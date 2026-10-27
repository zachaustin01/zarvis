// Turn blocked markers + the app's session records into the ordered attention queue.
//
// Working and idle sessions (hook-tracked, same resolution) follow the blocked ones, never twice.
//
// Leaf-only rule: the queue is built from markers, and a marker exists only for the session
// that is itself sitting at a permission prompt. A parent waiting on a blocked child has no
// marker, so it never appears (no rollup at MVP).
import path from 'node:path'
import { DESKTOP_ID, UUID, findTranscript, transcriptMeta, gitBranchOf } from './sessions.mjs'

export const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000
// A working session refreshes its marker on every tool call; one quiet this long was most likely
// interrupted (Esc fires no Stop hook), so it drops out.
export const DEFAULT_WORKING_MAX_AGE_MS = 30 * 60 * 1000
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/

/** The ticket id (ABC-123) a branch or worktree name carries, or ''. */
export const initiativeOf = (branch, worktree) => TICKET.exec(branch || '')?.[0] || TICKET.exec(worktree || '')?.[0] || ''

const isArchived = (r) => r.isArchived === true || r.isArchived === 'True'

/** Split `/repo/.claude/worktrees/x` into repo root and worktree name. */
export function splitWorktree(cwd) {
  const m = WORKTREE.exec(cwd || '')
  return m ? { root: cwd.slice(0, m.index), worktree: m[1] } : { root: cwd || '', worktree: '' }
}

// The app parks a session that starts with no folder in <app data>/scratch-workspaces/<id>.
const SCRATCH = /(?:^|[\\/])scratch-workspaces(?:[\\/]|$)/

/** Whether a path is (or is inside) one of the app's throwaway scratch workspaces. */
export const isScratch = (p) => SCRATCH.test(p || '')

/**
 * The project folder for a session: the repo it was opened from (`originCwd`, which a worktree
 * session keeps pointing at the repo) unless that is a scratch workspace the session has since left,
 * else the repo root of its current cwd.
 */
export function projectPathOf(cwd, originCwd = '') {
  return (originCwd && !isScratch(originCwd) ? originCwd : splitWorktree(cwd).root) || cwd || ''
}

/** The claude:// deep link that navigates the desktop app to a session it already has. */
export function deepLinkFor(desktopSessionId) {
  return DESKTOP_ID.test(desktopSessionId || '') ? `claude://claude.ai/epitaxy/${desktopSessionId}` : ''
}

/**
 * The claude:// deep link that opens a brand new Claude Code session in the desktop app — the
 * link Finder's "New Claude Code Session Here" action uses. With a folder the session starts in
 * it; without one the app opens a new session and lets you pick. `prompt` goes in the box as the
 * link's `q` parameter (the app rejects slash commands there).
 */
export function newSessionLink(folder, prompt = '') {
  const q = new URLSearchParams({ ...(folder ? { folder } : {}), ...(prompt ? { q: prompt } : {}) })
  return q.size ? `claude://code/new?${q}` : 'claude://code/new'
}

/** Pick the best desktop record for a CLI session id (twins: prefer titled, non-archived). */
export function pickRecord(records, sessionId) {
  const matches = records.filter((r) => r.cliSessionId === sessionId)
  matches.sort((a, b) => Number(Boolean(b.title)) - Number(Boolean(a.title)) || Number(isArchived(a)) - Number(isArchived(b)))
  return matches[0] || null
}

const realDeps = { findTranscript, transcriptMeta, gitBranchOf }

/**
 * @returns rows ordered blocked (longest wait first), working (longest running first), then idle
 * (most recently finished first). Each row:
 *   { sessionId, desktopSessionId, link, folder, project, initiative, branch, worktree, title,
 *     overlay, name, prompt, tool, command, since, waitMs, state }
 */
export async function buildQueue({ markers, working = [], records, deleted = new Set(), overlays = {}, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, workingMaxAgeMs = DEFAULT_WORKING_MAX_AGE_MS, deps = realDeps }) {
  const rows = []
  const blockedIds = new Set(markers.map((m) => m.sessionId))
  const tagged = [
    ...markers.map((m) => ({ m, state: 'blocked' })),
    ...working.filter((m) => !blockedIds.has(m.sessionId)).map((m) => ({ m, state: m.state })),
  ]
  for (const { m, state } of tagged) {
    if (state === 'working' ? now - m.seen > workingMaxAgeMs : now - m.at > maxAgeMs) continue // stale: the clearing hooks never ran
    if (deleted.has(m.sessionId)) continue
    const rec = pickRecord(records, m.sessionId)
    if (rec && isArchived(rec)) continue

    let tr = null
    if (!rec || !rec.title || !rec.branch) {
      tr = UUID.test(m.sessionId) ? await deps.findTranscript(m.sessionId) : null
    }
    if (!rec && !tr) continue // no record and no transcript: the session no longer exists

    const meta = tr ? await deps.transcriptMeta(tr.file) : { cwd: '', gitBranch: '', title: '' }
    // The hook marker's cwd is refreshed on every tool call; the record's is set once, so a session
    // that moved out of its scratch workspace only shows the move in the marker.
    const cwd = m.cwd || rec?.cwd || meta.cwd || ''
    const { worktree: wtFromPath } = splitWorktree(cwd)
    const projectPath = projectPathOf(cwd, rec?.originCwd)
    const worktree = rec?.worktreeName || wtFromPath
    const branch = rec?.branch || meta.gitBranch || (cwd ? await deps.gitBranchOf(cwd) : '')
    const title = rec?.title || meta.title || 'Untitled session'
    const desktopSessionId = rec?.sessionId || ''
    const overlay = overlays[m.sessionId]?.name || ''
    const ticket = initiativeOf(branch, worktree)

    rows.push({
      sessionId: m.sessionId,
      desktopSessionId,
      link: deepLinkFor(desktopSessionId),
      // The repo itself, not the session's worktree: where a new session for it should start.
      cwd,
      folder: projectPath,
      project: path.basename(projectPath) || 'unknown',
      initiative: ticket,
      branch,
      worktree,
      title,
      overlay,
      name: overlay || title,
      prompt: m.message,
      tool: m.tool,
      command: m.command,
      state,
      kind: state === 'blocked' ? m.kind || 'permission' : '',
      since: m.at,
      waitMs: Math.max(0, now - m.at),
    })
  }
  const rank = { blocked: 0, working: 1, idle: 2 }
  // Idle sessions list the most recently finished first; the others longest-waiting first.
  rows.sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'idle' ? b.since - a.since : a.since - b.since) || a.sessionId.localeCompare(b.sessionId))
  return rows
}

/**
 * Annotate queue rows with their role and roll blocked workers up into their manager: a manager
 * with a blocked worker is `waiting_on_child` (listed after the blocked rows, linking to the child),
 * never a second "needs you" for the same prompt. `nodes` is the result of roles.classify().
 */
export function applyRoles(rows, nodes) {
  const blockedUnder = new Map()
  for (const r of rows) {
    const mgr = nodes.get(r.sessionId)?.managerId
    if (r.state === 'blocked' && mgr) blockedUnder.set(mgr, [...(blockedUnder.get(mgr) || []), r])
  }
  const out = rows.map((r) => {
    const n = nodes.get(r.sessionId)
    const kids = blockedUnder.get(r.sessionId) || []
    const row = { ...r, role: n?.role || 'unclassified', suggested: n?.suggested || '', warnings: n?.warnings || [] }
    if (kids.length && r.state !== 'blocked') {
      Object.assign(row, { state: 'waiting_on_child', blockedChildren: kids.map((k) => ({ sessionId: k.sessionId, name: k.name })), prompt: `${kids.length} worker${kids.length > 1 ? 's' : ''} blocked` })
    }
    return row
  })
  const rank = { blocked: 0, waiting_on_child: 1, working: 2, idle: 3 }
  return out.sort((a, b) => rank[a.state] - rank[b.state] || out.indexOf(a) - out.indexOf(b))
}

/**
 * Rows for interface sessions that have no hook signal. The app shuts an idle session's process down,
 * which clears its markers, and the interface must not vanish from the queue for that: it stays, with
 * state `unknown` ("not running", never a guessed idle) until a live marker takes over. Archived sessions
 * are not classified at all, so they never get here; parked and done ones are dropped by the usual
 * lifecycle filters because the row is annotated like any other.
 * `nodes` is classify()'s result, `rows` the real rows (an interface that has one is left alone).
 */
export function interfaceRows(nodes, records, rows, { overlays = {}, now = Date.now() } = {}) {
  const have = new Set(rows.map((r) => r.sessionId))
  const out = []
  for (const n of nodes.values()) {
    if (n.role !== 'interface' || have.has(n.sessionId)) continue
    const rec = pickRecord(records, n.sessionId)
    if (!rec || isArchived(rec)) continue
    const cwd = n.cwd || rec.cwd || ''
    const { worktree: wtFromPath } = splitWorktree(cwd)
    const projectPath = projectPathOf(cwd, rec.originCwd)
    const worktree = rec.worktreeName || wtFromPath
    const branch = rec.branch || ''
    const since = Number(rec.lastActivityAt) || Number(rec.createdAt) || now
    const title = rec.title || n.title || 'Untitled session'
    const overlay = overlays[n.sessionId]?.name || ''
    out.push({
      sessionId: n.sessionId,
      desktopSessionId: rec.sessionId || '',
      link: deepLinkFor(rec.sessionId),
      cwd,
      folder: projectPath,
      project: path.basename(projectPath) || 'unknown',
      initiative: initiativeOf(branch, worktree),
      branch,
      worktree,
      title,
      overlay,
      name: overlay || title,
      prompt: 'Not running — no hook signal from this session',
      tool: '',
      command: '',
      state: 'unknown',
      kind: '',
      since,
      waitMs: Math.max(0, now - since),
      role: 'interface',
      suggested: '',
      warnings: n.warnings || [],
    })
  }
  return out
}
