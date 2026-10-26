// Blocked markers: ~/.zarvis/blocked/<sessionId>.json, written by hooks/zarvis-hook.mjs.
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const ZARVIS_HOME = process.env.ZARVIS_HOME || path.join(os.homedir(), '.zarvis')
export const BLOCKED_DIR = path.join(ZARVIS_HOME, 'blocked')

/** Session ids become file names, so they must be plain ids. */
export const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Validate one parsed marker. Returns a clean object or null. */
export function parseMarker(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!SAFE_ID.test(raw.sessionId || '')) return null
  const at = Number(raw.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return {
    sessionId: raw.sessionId,
    at,
    cwd: str(raw.cwd, 1000),
    message: str(raw.message),
    tool: str(raw.tool, 100),
    command: str(raw.command),
    transcriptPath: str(raw.transcriptPath, 1000),
  }
}

/** Read every marker in `dir`; unreadable or malformed files are skipped. */
export async function readMarkers(dir = BLOCKED_DIR) {
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const m = parseMarker(JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')))
      if (m && `${m.sessionId}.json` === n) out.push(m)
    } catch {
      /* mid-write or junk */
    }
  }
  return out
}
