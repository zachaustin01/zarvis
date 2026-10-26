// Turn blocked markers + the app's session records into the ordered attention queue.
//
// Leaf-only rule: the queue is built from markers, and a marker exists only for the session
// that is itself sitting at a permission prompt. A parent waiting on a blocked child has no
// marker, so it never appears (no rollup at MVP).
import path from 'node:path'
import { DESKTOP_ID, UUID, findTranscript, transcriptMeta, gitBranchOf } from './sessions.mjs'

export const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/

const isArchived = (r) => r.isArchived === true || r.isArchived === 'True'

/** Split `/repo/.claude/worktrees/x` into repo root and worktree name. */
export function splitWorktree(cwd) {
  const m = WORKTREE.exec(cwd || '')
  return m ? { root: cwd.slice(0, m.index), worktree: m[1] } : { root: cwd || '', worktree: '' }
}

/** The claude:// deep link that navigates the desktop app to a session it already has. */
export function deepLinkFor(desktopSessionId) {
  return DESKTOP_ID.test(desktopSessionId || '') ? `claude://claude.ai/epitaxy/${desktopSessionId}` : ''
}

/** Pick the best desktop record for a CLI session id (twins: prefer titled, non-archived). */
export function pickRecord(records, sessionId) {
  const matches = records.filter((r) => r.cliSessionId === sessionId)
  matches.sort((a, b) => Number(Boolean(b.title)) - Number(Boolean(a.title)) || Number(isArchived(a)) - Number(isArchived(b)))
  return matches[0] || null
}

const realDeps = { findTranscript, transcriptMeta, gitBranchOf }

/**
 * @returns rows ordered by longest wait first. Each row:
 *   { sessionId, desktopSessionId, link, project, initiative, branch, worktree, title,
 *     overlay, name, prompt, tool, command, since, waitMs }
 */
export async function buildQueue({ markers, records, deleted = new Set(), overlays = {}, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, deps = realDeps }) {
  const rows = []
  for (const m of markers) {
    if (now - m.at > maxAgeMs) continue // stale: the clearing hooks never ran
    if (deleted.has(m.sessionId)) continue
    const rec = pickRecord(records, m.sessionId)
    if (rec && isArchived(rec)) continue

    let tr = null
    if (!rec || !rec.title || !rec.branch) {
      tr = UUID.test(m.sessionId) ? await deps.findTranscript(m.sessionId) : null
    }
    if (!rec && !tr) continue // no record and no transcript: the session no longer exists

    const meta = tr ? await deps.transcriptMeta(tr.file) : { cwd: '', gitBranch: '', title: '' }
    const cwd = rec?.cwd || m.cwd || meta.cwd || ''
    const { root, worktree: wtFromPath } = splitWorktree(cwd)
    const projectPath = rec?.originCwd || root || cwd
    const worktree = rec?.worktreeName || wtFromPath
    const branch = rec?.branch || meta.gitBranch || (cwd ? await deps.gitBranchOf(cwd) : '')
    const title = rec?.title || meta.title || 'Untitled session'
    const desktopSessionId = rec?.sessionId || ''
    const overlay = overlays[m.sessionId]?.name || ''
    const ticket = TICKET.exec(branch)?.[0] || TICKET.exec(worktree)?.[0] || ''

    rows.push({
      sessionId: m.sessionId,
      desktopSessionId,
      link: deepLinkFor(desktopSessionId),
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
      since: m.at,
      waitMs: Math.max(0, now - m.at),
    })
  }
  rows.sort((a, b) => a.since - b.since || a.sessionId.localeCompare(b.sessionId))
  return rows
}
