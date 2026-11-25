// The role CLI's logic: set, clear, reset or inspect session roles in Zarvis's own store (~/.zarvis/state.json).
// Writes through the same lib/state.mjs code as /api/classify, so the running server picks changes up on its next tick,
// and it works with the server stopped. Never writes to Claude's files.
//
//   set <id> <interface|manager|worker|none> [--parent <managerId>] [--dry-run]
//   clear <id> [--dry-run]      explicit no-role ('none'): overrides hook tags in ~/.zarvis/roles/ and spawn inference
//   reset <id> [--dry-run]      drops the manual entry in state.json (falls back to hook tag or spawn inference)
//   get <id> [--json]
//   list [--json]
import { SAFE_ID } from './markers.mjs'
import { ROLES, NO_ROLE, classify } from './roles.mjs'
import { readState, setRole, STATE_FILE } from './state.mjs'
import { scanDesktopRecords, scanAntigravitySessions } from './sessions.mjs'
import { readRoleTags } from './registry.mjs'

const USAGE =
  'usage: npm run role -- set <id> <interface|manager|worker|none> [--parent <managerId>] [--dry-run] | clear <id> [--dry-run] | reset <id> [--dry-run] | get <id> [--json] | list [--json]'

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const VALID_SET_ROLES = [...ROLES, NO_ROLE]

export function parseArgs(argv) {
  const out = { cmd: argv[0] || '', args: [], parent: '', dryRun: false, json: false }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--parent') {
      if (i + 1 >= rest.length) throw refuse('--parent needs a value')
      out.parent = rest[++i]
    } else if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else out.args.push(a)
  }
  return out
}

/** The real world: desktop records, Antigravity sessions, and hook role tags on disk. */
export async function liveDeps() {
  const [{ records }, sessions, tagList] = await Promise.all([scanDesktopRecords(), scanAntigravitySessions(), readRoleTags()])
  const roles = {}
  for (const t of tagList) roles[t.sessionId] = { role: t.role, parent: t.parent }
  return { records, sessions, roles }
}

/** Find a classified node by CLI session id or the desktop app's `local_…` id. */
export function find(nodes, id) {
  if (!id) return null
  if (nodes.has(id)) return nodes.get(id)
  return [...nodes.values()].find((n) => n.desktopSessionId && n.desktopSessionId === id) || null
}

/**
 * Resolve `<id>` through live nodes or desktop records (so `local_…` resolves to `cliSessionId`),
 * falling back to raw `id` when `SAFE_ID.test(id)` so CLI-only or closed/stale sessions can still be updated.
 */
export function resolveTarget(nodes, records, rawId, errMsg = 'bad session id') {
  const q = String(rawId || '').trim()
  if (!q) throw refuse(errMsg)
  const node = find(nodes, q)
  if (node) return { sessionId: node.sessionId, title: node.title || '', node }
  const rec = (records || []).find((r) => (r.sessionId === q || r.cliSessionId === q) && r.cliSessionId)
  if (rec && SAFE_ID.test(rec.cliSessionId)) return { sessionId: rec.cliSessionId, title: rec.title || '', node: nodes.get(rec.cliSessionId) || null }
  if (!SAFE_ID.test(q)) throw refuse(errMsg)
  return { sessionId: q, title: '', node: null }
}

const label = ({ sessionId, title }) => (title && title !== 'Untitled session' ? `“${title}” (${sessionId})` : sessionId)

/** Run one role CLI command. Returns the process exit code. */
export async function runRole(argv, { deps, stateFile = STATE_FILE, log = console.log, err = console.error } = {}) {
  let usage = false
  try {
    const a = parseArgs(argv)
    if (!['set', 'clear', 'reset', 'get', 'list'].includes(a.cmd)) {
      usage = true
      throw refuse(a.cmd ? `unknown command ${a.cmd}` : 'no command given')
    }
    if (a.parent && a.cmd !== 'set') throw refuse('--parent is only valid with set <id> worker')

    const world = deps || (await liveDeps())
    const state = await readState(stateFile)
    const hookRoles = world.roles || {}
    const mergedRoles = { ...hookRoles, ...state.roles }
    const records = world.records || []
    const sessions = world.sessions || []
    const nodes = classify({ records, sessions, roles: mergedRoles, ...(world.cwds ? { cwds: world.cwds } : {}), ...(world.agyMeta ? { agyMeta: world.agyMeta } : {}) })

    if (a.cmd === 'list') {
      if (a.args.length) {
        usage = true
        throw refuse(`unexpected argument ${a.args[0]}`)
      }
      const rows = []
      const seen = new Set()
      for (const n of nodes.values()) {
        if (n.role === 'unclassified' && n.source !== 'cleared' && !state.roles[n.sessionId] && !hookRoles[n.sessionId]) continue
        seen.add(n.sessionId)
        const origin = state.roles[n.sessionId] ? 'state' : hookRoles[n.sessionId] ? 'hook' : n.source
        rows.push({
          sessionId: n.sessionId,
          desktopSessionId: n.desktopSessionId || '',
          title: n.title || 'Untitled session',
          role: n.source === 'cleared' ? NO_ROLE : n.role,
          origin,
          managerId: n.managerId || '',
          warnings: n.warnings || [],
        })
      }
      for (const [id, r] of Object.entries(mergedRoles)) {
        if (seen.has(id)) continue
        rows.push({
          sessionId: id,
          desktopSessionId: '',
          title: 'Untitled session',
          role: r?.role || 'unclassified',
          origin: state.roles[id] ? 'state' : 'hook',
          managerId: r?.parent || '',
          warnings: [],
        })
      }
      const order = { interface: 0, manager: 1, worker: 2, [NO_ROLE]: 3, unclassified: 4 }
      rows.sort((x, y) => (order[x.role] ?? 9) - (order[y.role] ?? 9) || x.sessionId.localeCompare(y.sessionId))
      if (a.json) log(JSON.stringify({ roles: rows }, null, 2))
      else if (!rows.length) log('no classified sessions')
      else {
        for (const r of rows) {
          const mgr = r.managerId ? ` · parent ${r.managerId}` : ''
          log(`${r.sessionId}  ${r.role} (${r.origin})  ${r.title}${mgr}`)
        }
      }
      return 0
    }

    if (a.cmd === 'get') {
      if (a.args.length !== 1) {
        usage = true
        throw refuse('get needs a session id')
      }
      const target = resolveTarget(nodes, records, a.args[0])
      const n = target.node
      const origin = state.roles[target.sessionId] ? 'state' : hookRoles[target.sessionId] ? 'hook' : n?.source || 'none'
      const info = {
        sessionId: target.sessionId,
        desktopSessionId: n?.desktopSessionId || '',
        title: target.title || n?.title || 'Untitled session',
        role: n ? (n.source === 'cleared' ? NO_ROLE : n.role) : (mergedRoles[target.sessionId]?.role || 'unclassified'),
        effectiveRole: n?.role || 'unclassified',
        origin,
        managerId: n?.managerId || '',
        suggested: n?.suggested || '',
        warnings: n?.warnings || [],
      }
      if (a.json) log(JSON.stringify(info, null, 2))
      else {
        const mgr = info.managerId ? ` · parent ${info.managerId}` : ''
        log(`${info.sessionId}  ${info.role} (${info.origin})  ${info.title}${mgr}`)
      }
      return 0
    }

    if (a.cmd === 'clear' || a.cmd === 'reset') {
      if (a.args.length !== 1) {
        usage = true
        throw refuse(`${a.cmd} needs a session id`)
      }
      const target = resolveTarget(nodes, records, a.args[0])
      if (a.cmd === 'clear') {
        // Explicit no-role ('none'), matching the `x` key in the UI (/api/classify): overrides hook tags and spawn inference.
        if (!a.dryRun) await setRole(target.sessionId, NO_ROLE, '', stateFile)
        log(`${a.dryRun ? 'would clear' : 'cleared'} role on ${label(target)} (set to none)`)
        return 0
      }
      if (!a.dryRun) await setRole(target.sessionId, '', '', stateFile)
      log(`${a.dryRun ? 'would reset' : 'reset'} manual role override on ${label(target)}`)
      return 0
    }

    // a.cmd === 'set'
    if (a.args.length !== 2) {
      usage = true
      throw refuse('set needs <id> and <interface|manager|worker|none>')
    }
    const [rawId, role] = a.args
    if (!VALID_SET_ROLES.includes(role)) {
      throw refuse(`role must be interface, manager, worker or none (got ${role})`)
    }
    if (a.parent && role !== 'worker') {
      throw refuse('--parent is only valid when setting role to worker')
    }
    const target = resolveTarget(nodes, records, rawId)
    let parentId = ''
    if (a.parent) {
      parentId = resolveTarget(nodes, records, a.parent, 'bad --parent session id').sessionId
      if (parentId === target.sessionId) throw refuse('a worker cannot be its own parent')
    }
    if (!a.dryRun) await setRole(target.sessionId, role, parentId, stateFile)
    const via = parentId ? ` (parent ${parentId})` : ''
    log(`${a.dryRun ? 'would set' : 'set'} ${label(target)} to ${role}${via}`)
    return 0
  } catch (e) {
    err(`role: ${e.message}`)
    if (usage) err(USAGE)
    return e.refusal || e.status === 400 ? 1 : 2
  }
}
