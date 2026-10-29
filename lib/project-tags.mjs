// Explicit project tags: ~/.zarvis/projects.json, { "<CLI session id>": { project, by?, at } }, written by
// `npm run project` (lib/project-cli.mjs) and read by the server, the roster and the Costs view.
//
// A session's project is, in order: its own tag, else its manager's tag (a worker follows the manager that
// attached it), else the folder name derived from where it runs (lib/queue.mjs projectPathOf, worktrees rolled up).
// Never throws on a bad file: it just yields no tags.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SAFE_ID } from './markers.mjs'

export const MAX_PROJECT = 60
export const tagsFile = (home) => path.join(home, 'projects.json')

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu

/** One line, trimmed, at most MAX_PROJECT characters; '' when nothing is left. */
export const cleanProject = (raw) => String(raw ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PROJECT).trim()

function parse(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    const project = cleanProject(typeof v === 'string' ? v : v?.project)
    if (SAFE_ID.test(id) && project) out[id] = { project, ...(SAFE_ID.test(v?.by || '') ? { by: v.by } : {}), at: Number(v?.at) || 0 }
  }
  return out
}

/** { sessionId: { project, by, at } } */
export async function readTags(home) {
  try {
    return parse(JSON.parse(await fsp.readFile(tagsFile(home), 'utf8')))
  } catch {
    return {}
  }
}

async function write(home, tags) {
  const file = tagsFile(home)
  await fsp.mkdir(home, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(tags, null, 2))
  await fsp.rename(tmp, file)
}

export async function setTag(home, id, project, by = '', now = Date.now()) {
  if (!SAFE_ID.test(id || '')) throw Object.assign(new Error('bad session id'), { refusal: true })
  const name = cleanProject(project)
  if (!name) throw Object.assign(new Error('project name is empty'), { refusal: true })
  const tags = await readTags(home)
  tags[id] = { project: name, ...(SAFE_ID.test(by || '') ? { by } : {}), at: now }
  await write(home, tags)
  return tags[id]
}

/** Remove a tag; returns the removed one or null. */
export async function clearTag(home, id) {
  const tags = await readTags(home)
  const gone = tags[id] || null
  if (!gone) return null
  delete tags[id]
  await write(home, tags)
  return gone
}

/**
 * The effective project of one session: { project, source: 'explicit' | 'manager' | 'derived' }.
 * `derived` is the folder name (may be ''), `managerId` the manager it is attached to (may be '').
 */
export function resolveProject(sessionId, { managerId = '', derived = '', tags = {} } = {}) {
  if (tags[sessionId]) return { project: tags[sessionId].project, source: 'explicit' }
  if (managerId && tags[managerId]) return { project: tags[managerId].project, source: 'manager' }
  return { project: derived, source: 'derived' }
}
