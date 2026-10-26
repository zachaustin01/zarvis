// Zarvis's own state: ~/.zarvis/state.json. The only file besides markers it ever writes.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ZARVIS_HOME, SAFE_ID } from './markers.mjs'
import { ROLES, NO_ROLE } from './roles.mjs'
import { WAKE_TYPES, wakeTime } from './lifecycle.mjs'

export const STATE_FILE = path.join(ZARVIS_HOME, 'state.json')

const EMPTY = () => ({ overlays: {}, roles: {}, parked: {}, done: {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const shape = (s) => ({ overlays: obj(s?.overlays), roles: obj(s?.roles), parked: obj(s?.parked), done: obj(s?.done) })

/**
 * Read the state, or throw if the file exists but is not valid JSON after a few short retries.
 * (Writes are atomic renames, so a torn read should clear at once; a file that stays garbage is real.)
 */
async function readStateStrict(file) {
  for (let i = 0; ; i++) {
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return EMPTY()
      throw e
    }
    try {
      return shape(JSON.parse(text))
    } catch {
      if (i >= 4) throw Object.assign(new Error(`${file} is not valid JSON; not overwriting it, fix or remove it by hand`), { status: 500 })
      await sleep(25)
    }
  }
}

/** For readers: tolerant, an unreadable file reads as empty. Never use the result to write; see withState. */
export async function readState(file = STATE_FILE) {
  try {
    return await readStateStrict(file)
  } catch {
    return EMPTY()
  }
}

const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 15_000

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Take `${file}.lock` (an exclusive create), waiting for the holder; break one whose owner is gone or that is stale. */
async function acquire(lock) {
  const token = `${process.pid}.${Math.random().toString(36).slice(2)}`
  const start = Date.now()
  for (;;) {
    try {
      const h = await fsp.open(lock, 'wx')
      await h.writeFile(token)
      await h.close()
      return token
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    try {
      const st = await fsp.stat(lock)
      const owner = Number.parseInt(await fsp.readFile(lock, 'utf8').catch(() => ''), 10)
      const dead = Number.isInteger(owner) && owner !== process.pid && !pidAlive(owner)
      if (dead || Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Moving it aside is atomic: of several breakers only one succeeds.
        await fsp.rename(lock, `${lock}.stale.${token}`).then(() => fsp.rm(`${lock}.stale.${token}`, { force: true }), () => {})
        continue
      }
    } catch {
      continue // it vanished between the create and the stat
    }
    if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for the lock on ${lock}`)
    await sleep(5 + Math.random() * 25)
  }
}

async function release(lock, token) {
  if ((await fsp.readFile(lock, 'utf8').catch(() => '')) === token) await fsp.rm(lock, { force: true })
}

/**
 * The one way to change state.json: take a cross-process lock, read the current state (failing
 * rather than treating a corrupt file as empty), let `fn` mutate it, then write it back atomically.
 * If `fn` throws nothing is written. Returns the new state.
 */
export async function withState(fn, file = STATE_FILE) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const token = await acquire(lock)
  try {
    const state = await readStateStrict(file)
    await fn(state)
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, file)
    return state
  } finally {
    await release(lock, token).catch(() => {})
  }
}

/** Set (or, when `name` is empty, clear) the overlay name for a session. */
export async function setOverlay(sessionId, name, file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw new Error('bad session id')
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return withState((state) => {
    if (clean) state.overlays[sessionId] = { name: clean, at: Date.now() }
    else delete state.overlays[sessionId]
  }, file)
}

/** Set a session's role (and, for a worker, its manager) in the registry; empty `role` drops the entry (back to hook tag / inference);
 * NO_ROLE stores an explicit "no role" that beats both. */
export async function setRole(sessionId, role, parent = '', file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw new Error('bad session id')
  return withState((state) => {
    if (!role) delete state.roles[sessionId]
    else if (role === NO_ROLE) state.roles[sessionId] = { role: NO_ROLE, at: Date.now() }
    else if (!ROLES.includes(role)) throw new Error('bad role')
    else state.roles[sessionId] = { role, ...(role === 'worker' && SAFE_ID.test(parent || '') ? { parent } : {}), at: Date.now() }
  }, file)
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
  return withState((state) => {
    state.parked[sessionId] = entry
    delete state.done[sessionId]
  }, file)
}

export async function unparkSession(sessionId, file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw bad('bad session id')
  return withState((state) => {
    delete state.parked[sessionId]
  }, file)
}

/** Mark a session done (hidden unless searched) or, with `done` false, bring it back. Done un-parks. */
export async function setDone(sessionId, done = true, file = STATE_FILE) {
  if (!SAFE_ID.test(sessionId)) throw bad('bad session id')
  return withState((state) => {
    if (done) {
      state.done[sessionId] = true
      delete state.parked[sessionId]
    } else delete state.done[sessionId]
  }, file)
}
