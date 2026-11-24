// The roster CLI's logic: one read-only lookup of the sessions Zarvis oversees, for agents (the
// interface, managers) that need real names instead of bare ids. Reads the same sources as the server
// (the app's session records, the role registry, hook markers, state.json), so it works with the server
// stopped and nobody has to read ~/.zarvis by hand. Never writes.
//
//   list [--query "words"] [--role interface|manager|worker|unclassified] [--manager <id>] [--running live|unknown|archived] [--all] [--json]
//   get <id> [--json]        id: CLI session id, the app's local_… id, or a unique prefix
import { readMarkers, BLOCKED_DIR, WORKING_DIR, ZARVIS_HOME } from './markers.mjs'
import { readState } from './state.mjs'
import { readAllTasks } from './tasks.mjs'
import { readAllLinks } from './links.mjs'
import { readTags } from './project-tags.mjs'
import { readJobs } from './schedule.mjs'
import { schedulesBySession } from './schedule-owner.mjs'
import { scanDesktopRecords, scanAntigravitySessions } from './sessions.mjs'
import { roleRegistry } from './registry.mjs'
import { buildLookup, findEntry } from './lookup.mjs'
import { promptsForSession } from './prompts.mjs'
import { scoreSession } from '../public/palette.js'
import { readClaims } from './claims.mjs'

const USAGE = 'usage: npm run roster -- list [--query "words"] [--field F] [--ticket KEY] [--source all|claude|antigravity] [--role R] [--manager <id>] [--running live|unknown|archived] [--exclude-branch] [--all] [--json] | get <id> [--json]'
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = {
  '--query': 'query',
  '--role': 'role',
  '--manager': 'manager',
  '--running': 'running',
  '--field': 'field',
  '--ticket': 'ticket',
  '--source': 'source',
}

export const VALID_FIELDS = new Set(['name', 'title', 'prompt', 'reply', 'project', 'branch', 'notes', 'links'])

export function parseArgs(argv) {
  const out = { cmd: argv[0] || 'list', id: '', query: '', role: '', manager: '', running: '', field: '', ticket: '', source: 'all', excludeBranch: false, all: false, json: false }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (FLAGS[a]) {
      if (i + 1 >= rest.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = rest[++i]
    } else if (a === '--json') out.json = true
    else if (a === '--all') out.all = true
    else if (a === '--exclude-branch') out.excludeBranch = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else if (!out.id) out.id = a
    else throw refuse(`unexpected argument ${a}`)
  }
  return out
}

/** The real world; tests pass their own with the same shape. */
export async function liveDeps() {
  const [{ records, deleted }, state, antigravity] = await Promise.all([scanDesktopRecords(), readState(), scanAntigravitySessions()])
  return { records, deleted, state, antigravity, roles: await roleRegistry(state), markers: await readMarkers(BLOCKED_DIR), working: await readMarkers(WORKING_DIR), tasks: await readAllTasks(ZARVIS_HOME), links: await readAllLinks(ZARVIS_HOME), schedules: schedulesBySession(await readJobs(ZARVIS_HOME)), projectTags: await readTags(ZARVIS_HOME) }
}

const PROJECT_NOTE = { explicit: ' (tagged)', manager: " (its manager's tag)" }
const RUNNING_TEXT = { live: 'live', unknown: 'unknown (no hook signal; may be idle or closed)', archived: 'archived (not running)' }
const age = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

const quote = (t, n = 220) => (t.length > n ? `${t.slice(0, n)}…` : t)

/** Entries matching a free-text query (every word must hit the name, project, branch, notes, links, first prompt or last reply), best first. */
export function searchEntries(entries, query, { fields = null, penalizeBranch = true } = {}) {
  return entries
    .map((e) => {
      const m = scoreSession(query, e, e.state, { fields, penalizeBranch })
      return { e: { ...e, _match: m }, m }
    })
    .filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.e)
}

/** Find sessions relevant to a ticket key, combining checkout claims, content (prompt/title) matches, and branch. */
export function searchByTicket(entries, ticketKey, claims = [], { fields = null } = {}) {
  const normKey = ticketKey.trim().toUpperCase()
  if (!normKey) return []

  const claimHolders = new Map()
  const claimShared = new Map()

  for (const { claim } of claims) {
    if (!claim) continue
    const labelUpper = (claim.label || '').toUpperCase()
    const branchUpper = (claim.branch || '').toUpperCase()
    if (labelUpper === normKey || labelUpper.includes(normKey) || branchUpper.includes(normKey)) {
      if (claim.holder?.sessionId) {
        claimHolders.set(claim.holder.sessionId, claim)
      }
      for (const s of claim.shared || []) {
        if (s.sessionId) claimShared.set(s.sessionId, claim)
      }
    }
  }

  const results = []
  for (const e of entries) {
    const isHolder = claimHolders.has(e.sessionId)
    const isShared = claimShared.has(e.sessionId)
    const m = scoreSession(ticketKey, e, e.state, { fields, penalizeBranch: true })

    if (!isHolder && !isShared && !m) continue

    let matchKind = 'branch_only'
    let rank = 1
    if (isHolder) {
      matchKind = 'claim_holder'
      rank = 4
    } else if (m && !m.branchOnly) {
      matchKind = 'content'
      rank = 3
    } else if (isShared) {
      matchKind = 'claim_shared'
      rank = 2
    }

    const claim = claimHolders.get(e.sessionId) || claimShared.get(e.sessionId)
    const entryWithMatch = {
      ...e,
      ticketMatch: {
        ticket: ticketKey,
        kind: matchKind,
        ...(claim ? { claimLabel: claim.label, claimRoot: claim.root } : {}),
      },
      _ticketRank: rank,
      _ticketScore: m ? m.score : 0,
    }
    results.push(entryWithMatch)
  }

  return results.sort((a, b) => (
    b._ticketRank - a._ticketRank ||
    b._ticketScore - a._ticketScore ||
    (b.lastActivityAt || 0) - (a.lastActivityAt || 0) ||
    a.sessionId.localeCompare(b.sessionId)
  ))
}

export function formatEntry(e, now) {
  const status = e.running === 'live' ? `live: ${e.state}${e.since ? ` for ${age(now - e.since)}` : ''}` : RUNNING_TEXT[e.running]
  const where = [e.project && `${e.project}${PROJECT_NOTE[e.projectSource] || ''}`, e.branch].filter(Boolean).join(' › ')
  const rel = e.managerId ? ` · manager ${e.managerName || '?'} (${e.managerId})` : ''
  const flags = [
    e.ticketMatch && (e.ticketMatch.kind === 'claim_holder' ? `claim holder for ${e.ticketMatch.ticket}` : e.ticketMatch.kind === 'content' ? `content match: ${e.ticketMatch.ticket}` : e.ticketMatch.kind === 'claim_shared' ? `shared claim: ${e.ticketMatch.ticket}` : `branch match only: ${e.ticketMatch.ticket}`),
    e.agent === 'antigravity' && 'Antigravity (not messageable)',
    e.parked && 'parked',
    e.done && 'done',
    e.tasks && `${e.tasks} background task${e.tasks > 1 ? 's' : ''}`,
    e.suggested && `looks like a ${e.suggested}`,
  ].filter(Boolean)
  return `- ${e.name} — ${e.role} — ${status}${flags.length ? ` — ${flags.join(' — ')}` : ''}${where ? ` — ${where}` : ''}\n    session \`${e.sessionId}\` · app \`${e.desktopSessionId}\`${rel}${e.cwd ? `\n    cwd ${e.cwd}` : ''}${e.prompt ? `\n    asked: ${quote(e.prompt)}` : ''}${e.reply ? `\n    last said: ${quote(e.reply)}` : ''}${(e.links || []).map((l) => `\n    link ${l.label} — ${l.url}`).join('')}${(e.schedules || []).map((s) => `\n    schedule ${s.name} — ${s.desc}${s.next ? ` — next ${new Date(s.next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`).join('')}`
}

export async function runRoster(argv, { deps, now = Date.now(), log = console.log, err = console.error } = {}) {
  try {
    const a = parseArgs(argv)
    if (!['list', 'get'].includes(a.cmd)) throw Object.assign(refuse(`unknown command ${a.cmd}`), { usage: true })
    if (a.running && !['live', 'unknown', 'archived'].includes(a.running)) throw refuse('--running must be live, unknown or archived')
    if (a.source && !['all', 'claude', 'antigravity'].includes(a.source)) throw refuse('--source must be all, claude or antigravity')

    let allowedFields = null
    if (a.field) {
      const parts = a.field.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      if (!parts.length) throw refuse('--field needs a comma-separated list of fields')
      for (const f of parts) {
        if (!VALID_FIELDS.has(f)) throw refuse(`unknown field "${f}" in --field (valid: ${[...VALID_FIELDS].join(', ')})`)
      }
      allowedFields = new Set(parts)
    }
    if (a.excludeBranch) {
      if (!allowedFields) allowedFields = new Set([...VALID_FIELDS].filter((f) => f !== 'branch'))
      else allowedFields.delete('branch')
    }

    const world = deps || (await liveDeps())
    const claims = world.claims || readClaims()
    const wantsText = a.cmd === 'get' || Boolean(a.query.trim()) || Boolean(a.ticket.trim())
    const entries = await buildLookup({
      ...world,
      now,
      all: a.all || a.cmd === 'get' || a.running === 'archived',
      source: a.source,
      ...(wantsText ? { textOf: world.textOf || promptsForSession } : {}),
    })
    if (a.cmd === 'get') {
      const { entry, error } = findEntry(entries, a.id)
      if (error) throw refuse(error)
      log(a.json ? JSON.stringify(entry, null, 2) : formatEntry(entry, now))
      return 0
    }
    const mgr = a.manager ? findEntry(entries, a.manager) : null
    if (mgr?.error) throw refuse(mgr.error)
    const filtered = entries.filter((e) => (!a.role || e.role === a.role) && (!mgr || e.managerId === mgr.entry.sessionId) && (!a.running || e.running === a.running))
    let shown = filtered
    if (a.ticket.trim()) {
      shown = searchByTicket(filtered, a.ticket, claims, { fields: allowedFields })
    } else if (a.query.trim()) {
      shown = searchEntries(filtered, a.query, { fields: allowedFields, penalizeBranch: true })
    }
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
