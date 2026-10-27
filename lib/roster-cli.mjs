// The roster CLI's logic: one read-only lookup of the sessions Zarvis oversees, for agents (the
// interface, managers) that need real names instead of bare ids. Reads the same sources as the server
// (the app's session records, the role registry, hook markers, state.json), so it works with the server
// stopped and nobody has to read ~/.zarvis by hand. Never writes.
//
//   list [--role interface|manager|worker|unclassified] [--manager <id>] [--running live|unknown|archived] [--all] [--json]
//   get <id> [--json]        id: CLI session id, the app's local_… id, or a unique prefix
import { readMarkers, BLOCKED_DIR, WORKING_DIR, ZARVIS_HOME } from './markers.mjs'
import { readState } from './state.mjs'
import { readAllTasks } from './tasks.mjs'
import { scanDesktopRecords } from './sessions.mjs'
import { roleRegistry } from './registry.mjs'
import { buildLookup, findEntry } from './lookup.mjs'

const USAGE = 'usage: npm run roster -- list [--role R] [--manager <id>] [--running live|unknown|archived] [--all] [--json] | get <id> [--json]'
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = { '--role': 'role', '--manager': 'manager', '--running': 'running' }

export function parseArgs(argv) {
  const out = { cmd: argv[0] || 'list', id: '', role: '', manager: '', running: '', all: false, json: false }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (FLAGS[a]) {
      if (i + 1 >= rest.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = rest[++i]
    } else if (a === '--json') out.json = true
    else if (a === '--all') out.all = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else if (!out.id) out.id = a
    else throw refuse(`unexpected argument ${a}`)
  }
  return out
}

/** The real world; tests pass their own with the same shape. */
export async function liveDeps() {
  const [{ records, deleted }, state] = await Promise.all([scanDesktopRecords(), readState()])
  return { records, deleted, state, roles: await roleRegistry(state), markers: await readMarkers(BLOCKED_DIR), working: await readMarkers(WORKING_DIR), tasks: await readAllTasks(ZARVIS_HOME) }
}

const RUNNING_TEXT = { live: 'live', unknown: 'unknown (no hook signal; may be idle or closed)', archived: 'archived (not running)' }
const age = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

export function formatEntry(e, now) {
  const status = e.running === 'live' ? `live: ${e.state}${e.since ? ` for ${age(now - e.since)}` : ''}` : RUNNING_TEXT[e.running]
  const where = [e.project, e.branch].filter(Boolean).join(' › ')
  const rel = e.managerId ? ` · manager ${e.managerName || '?'} (${e.managerId})` : ''
  const flags = [e.parked && 'parked', e.done && 'done', e.tasks && `${e.tasks} background task${e.tasks > 1 ? 's' : ''}`, e.suggested && `looks like a ${e.suggested}`].filter(Boolean)
  return `- ${e.name} — ${e.role} — ${status}${flags.length ? ` — ${flags.join(', ')}` : ''}${where ? ` — ${where}` : ''}\n    session \`${e.sessionId}\` · app \`${e.desktopSessionId}\`${rel}${e.cwd ? `\n    cwd ${e.cwd}` : ''}`
}

export async function runRoster(argv, { deps, now = Date.now(), log = console.log, err = console.error } = {}) {
  try {
    const a = parseArgs(argv)
    if (!['list', 'get'].includes(a.cmd)) throw Object.assign(refuse(`unknown command ${a.cmd}`), { usage: true })
    if (a.running && !['live', 'unknown', 'archived'].includes(a.running)) throw refuse('--running must be live, unknown or archived')
    const world = deps || (await liveDeps())
    const entries = await buildLookup({ ...world, now, all: a.all || a.cmd === 'get' || a.running === 'archived' })
    if (a.cmd === 'get') {
      const { entry, error } = findEntry(entries, a.id)
      if (error) throw refuse(error)
      log(a.json ? JSON.stringify(entry, null, 2) : formatEntry(entry, now))
      return 0
    }
    const mgr = a.manager ? findEntry(entries, a.manager) : null
    if (mgr?.error) throw refuse(mgr.error)
    const shown = entries.filter((e) => (!a.role || e.role === a.role) && (!mgr || e.managerId === mgr.entry.sessionId) && (!a.running || e.running === a.running))
    if (a.json) log(JSON.stringify({ sessions: shown }, null, 2))
    else if (!shown.length) log('no matching sessions')
    else for (const e of shown) log(formatEntry(e, now))
    return 0
  } catch (e) {
    err(`roster: ${e.message}`)
    if (e.usage) err(USAGE)
    return e.refusal ? 1 : 2
  }
}
