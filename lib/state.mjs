// Zarvis's own state: ~/.zarvis/state.json. The only file besides markers it ever writes.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ZARVIS_HOME, SAFE_ID } from './markers.mjs'
import { ROLES, NO_ROLE } from './roles.mjs'
import { WAKE_TYPES, wakeTime } from './lifecycle.mjs'

export const STATE_FILE = path.join(ZARVIS_HOME, 'state.json')

export async function readState(file = STATE_FILE) {
  try {
    const s = JSON.parse(await fsp.readFile(file, 'utf8'))
    const obj = (v) => (v && typeof v === 'object' ? v : {})
    return { overlays: obj(s?.overlays), roles: obj(s?.roles), parked: obj(s?.parked), done: obj(s?.done) }
  } catch {
    return { overlays: {}, roles: {}, parked: {}, done: {} }
  }
}

/** Set (or, when `name` is empty, clear) the overlay name for a session. */
export async function setOverlay(sessionId, name, file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw new Error('bad session id')
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const state = await readState(file)
  if (clean) state.overlays[sessionId] = { name: clean, at: Date.now() }
  else delete state.overlays[sessionId]
  await writeState(state, file)
  return state
}

/** Set a session's role (and, for a worker, its manager) in the registry; empty `role` drops the entry (back to hook tag / inference);
 * NO_ROLE stores an explicit "no role" that beats both. */
export async function setRole(sessionId, role, parent = '', file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw new Error('bad session id')
  const state = await readState(file)
  if (!role) delete state.roles[sessionId]
  else if (role === NO_ROLE) state.roles[sessionId] = { role: NO_ROLE, at: Date.now() }
  else if (!ROLES.includes(role)) throw new Error('bad role')
  else state.roles[sessionId] = { role, ...(role === 'worker' && SAFE_ID.test(parent || '') ? { parent } : {}), at: Date.now() }
  await writeState(state, file)
  return state
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 })
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Validate park fields and build the stored entry (throws a 400 on bad input). Pure. */
export function cleanPark({ reason, wake, handoffNote, parkedBy } = {}, now = Date.now()) {
  const clean = oneLine(reason, 200)
  if (!clean) throw bad('a park needs a reason')
  const type = wake?.type ?? 'none'
  if (!WAKE_TYPES.includes(type)) throw bad('bad wake type')
  if (type === 'date' && Number.isNaN(wakeTime(wake.value))) throw bad('wake date must be YYYY-MM-DD')
  if (parkedBy && !SAFE_ID.test(parkedBy)) throw bad('bad parkedBy id')
  return {
    parkedAt: now,
    parkedBy: parkedBy || '', // the manager that parked it; '' when parked by hand in the UI
    reason: clean,
    wake: type === 'date' ? { type, value: wake.value } : null,
    handoffNote: String(handoffNote ?? '').trim().slice(0, 4000),
  }
}

/** Park a session with a reason, an optional date wake condition and a handoff note. Parking un-dones it. */
export async function parkSession(sessionId, fields = {}, file = STATE_FILE, now = Date.now()) {
  if (!SAFE_ID.test(sessionId)) throw bad('bad session id')
  const entry = cleanPark(fields, now)
  const state = await readState(file)
  state.parked[sessionId] = entry
  delete state.done[sessionId]
  await writeState(state, file)
  return state
}

export async function unparkSession(sessionId, file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw bad('bad session id')
  const state = await readState(file)
  delete state.parked[sessionId]
  await writeState(state, file)
  return state
}

/** Mark a session done (hidden unless searched) or, with `done` false, bring it back. Done un-parks. */
export async function setDone(sessionId, done = true, file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw bad('bad session id')
  const state = await readState(file)
  if (done) {
    state.done[sessionId] = true
    delete state.parked[sessionId]
  } else delete state.done[sessionId]
  await writeState(state, file)
  return state
}

async function writeState(state, file) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, file)
}
