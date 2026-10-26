// The park CLI's logic: a manager parks (and unparks) its own finished workers, tracked in Zarvis's
// own store. Writes through the same lib/state.mjs code as /api/park, so the running server just
// picks the change up on its next tick. Never writes to Claude's files.
//
//   park <sessionId> --by <managerId> --reason "..." [--note "..."] [--wake YYYY-MM-DD] [--force] [--dry-run]
//   unpark <sessionId> --by <managerId> [--dry-run]
//   list [--by <managerId>]
import { SAFE_ID, readMarkers, BLOCKED_DIR, WORKING_DIR } from './markers.mjs'
import { classify } from './roles.mjs'
import { readState, parkSession, unparkSession, cleanPark, STATE_FILE } from './state.mjs'
import { DEFAULT_MAX_AGE_MS, DEFAULT_WORKING_MAX_AGE_MS } from './queue.mjs'
import { scanDesktopRecords } from './sessions.mjs'
import { roleRegistry } from './registry.mjs'

const USAGE = 'usage: npm run park -- park|unpark|list ... (park <id> --by <manager> --reason "..." [--note ".."] [--wake YYYY-MM-DD] [--force] [--dry-run] | unpark <id> --by <manager> | list [--by <manager>])'

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = { '--by': 'by', '--reason': 'reason', '--note': 'note', '--wake': 'wake' }

export function parseArgs(argv) {
  const out = { cmd: argv[0], id: '', by: '', reason: '', note: '', wake: '', force: false, dryRun: false }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (FLAGS[a]) {
      if (i + 1 >= rest.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = rest[++i]
    } else if (a === '--force') out.force = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else if (!out.id) out.id = a
    else throw refuse(`unexpected argument ${a}`)
  }
  return out
}

/** The real world: the app's records, the role registry, the hook markers. Tests pass their own. */
export async function liveDeps() {
  const [{ records }, state] = await Promise.all([scanDesktopRecords(), readState()])
  return { records, roles: await roleRegistry(state), blocked: await readMarkers(BLOCKED_DIR), working: await readMarkers(WORKING_DIR) }
}

/** A node by CLI id or the app's `local_…` id. */
function find(nodes, id) {
  if (nodes.has(id)) return nodes.get(id)
  return [...nodes.values()].find((n) => n.desktopSessionId === id)
}

const label = (n) => `“${n.title}” (${n.sessionId})`

/** Throws a refusal unless `target` is a worker of the manager `by`. Returns both nodes. */
function authorize(nodes, id, byId) {
  if (!SAFE_ID.test(byId || '')) throw refuse('--by must be your own session id (see the roster)')
  if (!SAFE_ID.test(id || '')) throw refuse('bad session id')
  const by = find(nodes, byId)
  if (!by) throw refuse(`--by ${byId} is not a live session Zarvis knows`)
  if (by.role !== 'manager') throw refuse(`--by ${label(by)} is a ${by.role}, not a manager`)
  const target = find(nodes, id)
  if (!target) throw refuse(`${id} is not a live session Zarvis knows`)
  if (target.role === 'interface') throw refuse(`${label(target)} is the interface session; it is never parked`)
  if (target.role === 'manager') throw refuse(`${label(target)} is a manager; only workers are parked`)
  if (target.role !== 'worker' || target.managerId !== by.sessionId) throw refuse(`${label(target)} is not a worker of ${label(by)}`)
  return { by, target }
}

/** 'blocked' | 'working' | '' from the hook markers, ignoring ones too old to trust (as the queue does). */
function activity(id, { blocked = [], working = [] }, now) {
  if (blocked.some((m) => m.sessionId === id && now - m.at <= DEFAULT_MAX_AGE_MS)) return 'blocked'
  if (working.some((m) => m.sessionId === id && m.state === 'working' && now - m.seen <= DEFAULT_WORKING_MAX_AGE_MS)) return 'working'
  return ''
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10)

/** Run one command. Returns the process exit code; prints one result line (or one refusal line). */
export async function runPark(argv, { deps, stateFile = STATE_FILE, now = Date.now(), log = console.log, err = console.error } = {}) {
  try {
    const a = parseArgs(argv)
    if (!['park', 'unpark', 'list'].includes(a.cmd)) throw Object.assign(refuse(`unknown command ${a.cmd || '(none)'}`), { usage: true })
    const world = deps || (await liveDeps())
    const nodes = classify({ records: world.records, roles: world.roles })
    const state = await readState(stateFile)

    if (a.cmd === 'list') {
      if (a.by && !SAFE_ID.test(a.by)) throw refuse('bad --by id')
      const by = a.by ? find(nodes, a.by) : null
      const rows = Object.entries(state.parked)
        .map(([id, p]) => ({ id, p, n: nodes.get(id) }))
        .filter(({ p, n }) => !by || p.parkedBy === by.sessionId || n?.managerId === by.sessionId)
        .sort((x, y) => y.p.parkedAt - x.p.parkedAt)
      if (!rows.length) log('nothing parked')
      for (const { id, p, n } of rows) {
        const who = p.parkedBy ? `by ${nodes.get(p.parkedBy)?.title || p.parkedBy}` : 'by hand'
        const wake = p.wake ? ` · wakes ${p.wake.value}` : ''
        const note = p.handoffNote ? ` · note: ${p.handoffNote.split('\n')[0]}` : ''
        log(`${id}  ${n?.title || '(not live)'}  parked ${day(p.parkedAt)} ${who} — ${p.reason}${wake}${note}`)
      }
      return 0
    }

    const { target } = authorize(nodes, a.id, a.by)
    if (a.cmd === 'unpark') {
      if (!state.parked[target.sessionId]) {
        log(`${label(target)} is not parked`)
        return 0
      }
      if (!a.dryRun) await unparkSession(target.sessionId, stateFile)
      log(`${a.dryRun ? 'would unpark' : 'unparked'} ${label(target)}`)
      return 0
    }

    if (!a.reason.trim()) throw refuse('--reason is required')
    const busy = activity(target.sessionId, world, now)
    if (busy && !a.force) throw refuse(`${label(target)} is ${busy}; park it when it is idle (or pass --force)`)
    const again = Boolean(state.parked[target.sessionId])
    const fields = { reason: a.reason, wake: a.wake ? { type: 'date', value: a.wake } : null, handoffNote: a.note, parkedBy: find(nodes, a.by).sessionId }
    cleanPark(fields, now) // same validation as the real write, so a dry run refuses what a real run would
    if (a.dryRun) {
      log(`would ${again ? 're-park' : 'park'} ${label(target)}: ${a.reason}`)
      return 0
    }
    await parkSession(target.sessionId, fields, stateFile, now)
    log(`${again ? 're-parked' : 'parked'} ${label(target)}: ${a.reason}`)
    return 0
  } catch (e) {
    err(`park: ${e.message}`)
    if (e.usage) err(USAGE)
    return e.refusal || e.status === 400 ? 1 : 2
  }
}
