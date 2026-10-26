// Zarvis's own state: ~/.zarvis/state.json. The only file besides markers it ever writes.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ZARVIS_HOME, SAFE_ID } from './markers.mjs'

export const STATE_FILE = path.join(ZARVIS_HOME, 'state.json')

export async function readState(file = STATE_FILE) {
  try {
    const s = JSON.parse(await fsp.readFile(file, 'utf8'))
    return { overlays: s && typeof s.overlays === 'object' && s.overlays ? s.overlays : {} }
  } catch {
    return { overlays: {} }
  }
}

/** Set (or, when `name` is empty, clear) the overlay name for a session. */
export async function setOverlay(sessionId, name, file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw new Error('bad session id')
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const state = await readState(file)
  if (clean) state.overlays[sessionId] = { name: clean, at: Date.now() }
  else delete state.overlays[sessionId]
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, file)
  return state
}
