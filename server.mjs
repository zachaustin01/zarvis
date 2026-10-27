#!/usr/bin/env node
// Zarvis: read-only attention queue over Claude Code desktop sessions. Zero dependencies.
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readMarkers, hookStatus, WORKING_DIR, ZARVIS_HOME } from './lib/markers.mjs'
import { classify, childrenOf, roleMarker, rolePrompt, isNewSessionRole, NO_ROLE } from './lib/roles.mjs'
import { renderRoster } from './lib/roster.mjs'
import { scanDesktopRecords, gitBranchOf } from './lib/sessions.mjs'
import { buildQueue, applyRoles, newSessionLink, deepLinkFor, splitWorktree, projectPathOf, initiativeOf, DEFAULT_MAX_AGE_MS, DEFAULT_WORKING_MAX_AGE_MS } from './lib/queue.mjs'
import { roleRegistry } from './lib/registry.mjs'
import { readState, setOverlay, setRole, parkSession, unparkSession, setDone } from './lib/state.mjs'
import { readClaims, claimView, realDeps, psLstart } from './lib/claims.mjs'
import { readEvents } from './lib/events.mjs'
import { annotateRows, visibleRows, lifecycleOf, hideDone, archivedParked } from './lib/lifecycle.mjs'

const PORT = Number(process.env.ZARVIS_PORT) || 5274
const HOST = '127.0.0.1' // loopback only, by design
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
const MAX_AGE_MS = (Number(process.env.ZARVIS_MAX_AGE_HOURS) || DEFAULT_MAX_AGE_MS / 3600000) * 3600000
const WORKING_MAX_AGE_MS = (Number(process.env.ZARVIS_WORKING_MAX_AGE_MIN) || DEFAULT_WORKING_MAX_AGE_MS / 60000) * 60000
const DRY_OPEN = process.env.ZARVIS_DRY_OPEN === '1' // report the URL instead of opening it

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

/** Host stops DNS rebinding; Origin (required on POST) stops cross-site requests. */
const allowedHosts = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`])
function requestAllowed(req) {
  const hosts = allowedHosts()
  if (!hosts.has(String(req.headers.host || '').toLowerCase())) return false
  const origin = req.headers.origin
  if (req.method === 'POST') {
    if (!origin) return false
    try {
      if (!hosts.has(new URL(origin).host.toLowerCase())) return false
    } catch {
      return false
    }
    return /^application\/json\b/i.test(req.headers['content-type'] || '')
  }
  if (origin && origin !== 'null') {
    try {
      return hosts.has(new URL(origin).host.toLowerCase())
    } catch {
      return false
    }
  }
  return true
}

/** A session's display name (overlay, else app title) by CLI id, for naming the parking manager. */
const nameFn = (nodes, state) => (id) => state.overlays[id]?.name || nodes.get(id)?.title || ''

/** CLI session id -> the cwd the queue resolved for it (hook marker first), for sessions that have a row. */
const cwdsOf = (rows) => Object.fromEntries(rows.filter((r) => r.cwd).map((r) => [r.sessionId, r.cwd]))

/** Every hook-signalled session with its lifecycle facts; parked and done ones included. */
async function allRows() {
  const [markers, working] = await Promise.all([readMarkers(), readMarkers(WORKING_DIR)])
  if (!markers.length && !working.length) return []
  const [{ records, deleted }, state] = await Promise.all([scanDesktopRecords(), readState()])
  const rows = await buildQueue({ markers, working, records, deleted, overlays: state.overlays, maxAgeMs: MAX_AGE_MS, workingMaxAgeMs: WORKING_MAX_AGE_MS })
  const nodes = classify({ records, roles: await roleRegistry(state), cwds: cwdsOf(rows) })
  return annotateRows(applyRoles(rows, nodes), state, Date.now(), nameFn(nodes, state))
}

/** The "Needs you" queue: done and parked sessions filtered out (see lifecycle.visibleRows). */
async function currentQueue() {
  return visibleRows(await allRows())
}

const RECENT_MS = 7 * 24 * 3600 * 1000
const STATE_RANK = { blocked: 0, waiting_on_child: 1, working: 2, idle: 3 }

/** The role tree: the interface pinned, managers with their workers, then everything unclassified. */
async function currentTree() {
  const [{ records }, state, queue] = await Promise.all([scanDesktopRecords(), readState(), allRows()])
  const nodes = classify({ records, roles: await roleRegistry(state), cwds: cwdsOf(queue) })
  const rowOf = new Map(queue.map((r) => [r.sessionId, r]))
  const kids = childrenOf(nodes)
  const now = Date.now()
  const recent = new Map(records.map((r) => [r.cliSessionId, Number(r.lastActivityAt) || Number(r.createdAt) || now]))
  // Branch for every session, not just ones with a hook signal: the record's, else the checkout's HEAD.
  const recOf = new Map(records.map((r) => [r.cliSessionId, r]))
  const branchOf = new Map(
    await Promise.all([...nodes.values()].map(async (n) => [n.sessionId, recOf.get(n.sessionId)?.branch || (n.cwd ? await gitBranchOf(n.cwd) : '')])),
  )
  const view = (n) => {
    const row = rowOf.get(n.sessionId)
    const overlay = state.overlays[n.sessionId]?.name || ''
    const branch = row?.branch || branchOf.get(n.sessionId) || ''
    const worktree = row?.worktree || recOf.get(n.sessionId)?.worktreeName || splitWorktree(n.cwd).worktree
    return {
      sessionId: n.sessionId,
      desktopSessionId: n.desktopSessionId,
      branch,
      worktree,
      initiative: row?.initiative ?? initiativeOf(branch, worktree),
      link: row?.link ?? deepLinkFor(n.desktopSessionId),
      title: n.title,
      overlay,
      name: overlay || n.title,
      role: n.role,
      suggested: n.suggested,
      warnings: n.warnings,
      state: row?.state ?? 'unknown', // no hook signal: never guess
      kind: row?.kind ?? '',
      blockedChildren: row?.blockedChildren ?? [],
      project: row?.project || path.basename(projectPathOf(n.cwd, recOf.get(n.sessionId)?.originCwd)) || '',
      ...lifecycleOf(state, n.sessionId, now, nameFn(nodes, state)),
    }
  }
  const byState = (a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || a.name.localeCompare(b.name)
  const all = [...nodes.values()]
  const managers = all
    .filter((n) => n.role === 'manager')
    .map((n) => ({ ...view(n), children: (kids.get(n.sessionId) || []).map(view).sort(byState) }))
    .sort(byState)
  // Anything with a hook signal, plus recent activity, so old sessions don't swamp the bucket.
  const unclassified = all
    .filter((n) => n.role === 'unclassified' && (rowOf.has(n.sessionId) || now - (recent.get(n.sessionId) || 0) < RECENT_MS))
    .map(view)
    .sort(byState)
  const orphans = all.filter((n) => n.role === 'worker' && !kids.get(n.managerId)?.includes(n)).map(view).sort(byState)
  // Parked sessions whose app record is archived: shown only in the Parked view (and the roster), never in the tree or queue.
  const archived = archivedParked(records, state, await roleRegistry(state)).map((n) => {
    const worktree = splitWorktree(n.cwd).worktree
    return {
      ...n,
      worktree,
      initiative: initiativeOf(n.branch, worktree),
      link: deepLinkFor(n.desktopSessionId),
      overlay: state.overlays[n.sessionId]?.name || '',
      name: state.overlays[n.sessionId]?.name || n.title,
      suggested: '',
      warnings: [],
      state: 'unknown',
      kind: '',
      blockedChildren: [],
      project: path.basename(splitWorktree(n.cwd).root) || '',
      ...lifecycleOf(state, n.sessionId, now, nameFn(nodes, state)),
    }
  })
  return { interface: all.filter((n) => n.role === 'interface').map(view), managers, orphans, unclassified, archived }
}

// --- checkout claims: read-only; the hook and the claims CLI write them ---
const lstartOf = new Map() // a live pid's start time never changes, so one `ps` per pid
const claimProbes = {
  kill: realDeps.kill,
  lstart(pid) {
    if (!lstartOf.has(pid)) {
      if (lstartOf.size > 500) lstartOf.clear()
      lstartOf.set(pid, psLstart(pid))
    }
    return lstartOf.get(pid)
  },
}

/** Every claim as the UI shows it: holder and sharer names are the app's current titles (or hand-set names) when known. */
async function currentClaims() {
  const entries = readClaims()
  if (!entries.length) return []
  const [{ records }, state] = await Promise.all([scanDesktopRecords(), readState()])
  const names = {}
  for (const r of records) if (r.cliSessionId && r.title) names[r.cliSessionId] = r.title
  for (const [id, o] of Object.entries(state.overlays)) if (o?.name) names[id] = o.name
  const now = Date.now()
  return entries.map((e) => claimView(e, now, claimProbes, names)).sort((a, b) => b.holder.lastWrite - a.holder.lastWrite)
}

const EVENTS_SHOWN = 30 // pushed events sent to the browser (it keeps up to 40 and scrolls through them)

/** The newest pushed events (oldest first), each with the display name of its session when that is known. */
async function currentEvents() {
  const events = readEvents(ZARVIS_HOME, EVENTS_SHOWN)
  if (!events.some((e) => e.sessionId)) return events
  const [{ records }, state] = await Promise.all([scanDesktopRecords(), readState()])
  const names = {}
  for (const r of records) if (r.cliSessionId && r.title) names[r.cliSessionId] = r.title
  for (const [id, o] of Object.entries(state.overlays)) if (o?.name) names[id] = o.name
  return events.map((e) => (names[e.sessionId] ? { ...e, name: names[e.sessionId] } : e))
}

function openUrl(url) {
  if (DRY_OPEN) return Promise.resolve()
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10000 }, (err) => (err ? reject(err) : resolve())))
}

/** `folder` if it is an absolute path to a directory still on this machine, else ''. */
async function usableFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return ''
  try {
    return (await fsp.stat(folder)).isDirectory() ? folder : ''
  } catch {
    return ''
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 16 * 1024) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// --- the roster file: every manager with its workers, for the managers themselves to read ---
const ROSTER_FILE = path.join(ZARVIS_HOME, 'roster.md')
let lastRoster = ''
async function writeRoster() {
  const text = renderRoster(hideDone(await currentTree()), await currentClaims())
  if (text === lastRoster) return
  await fsp.mkdir(ZARVIS_HOME, { recursive: true })
  const tmp = `${ROSTER_FILE}.${process.pid}.tmp`
  await fsp.writeFile(tmp, text)
  await fsp.rename(tmp, ROSTER_FILE)
  lastRoster = text
}

/** A tree node by CLI session id, for opening sessions that have no queue row. */
async function findInTree(sessionId) {
  const t = await currentTree()
  const flat = [...t.interface, ...t.managers.flatMap((m) => [m, ...m.children]), ...t.orphans, ...t.unclassified, ...t.archived]
  return flat.find((n) => n.sessionId === sessionId)
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

// --- live updates: poll the marker dir once a second, push only on change ---
const clients = new Set()
let lastSig = ''
let lastQueue = []
let lastHook = { status: 'absent', lastAt: 0 }
let lastClaims = []
let lastEvents = []
const payload = () => ({ now: Date.now(), queue: lastQueue, hook: lastHook, claims: lastClaims, events: lastEvents })
async function tick() {
  try {
    lastQueue = await currentQueue()
    lastHook = hookStatus([...(await readMarkers()), ...(await readMarkers(WORKING_DIR))])
    lastClaims = await currentClaims()
    lastEvents = await currentEvents()
    const sig = JSON.stringify([lastQueue.map(({ waitMs, ...r }) => r), lastHook, lastClaims, lastEvents])
    if (sig !== lastSig) {
      lastSig = sig
      for (const c of clients) c.write(`data: ${JSON.stringify(payload())}\n\n`)
    }
  } catch (e) {
    console.error('scan failed:', e.message)
  }
}

const server = http.createServer(async (req, res) => {
  if (!requestAllowed(req)) return send(res, 403, { error: 'forbidden' })
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/api/queue') {
      await tick()
      return send(res, 200, payload())
    }
    // /api/events is the live stream for an EventSource (Accept: text/event-stream) and the pushed events as JSON for anything else.
    if (req.method === 'GET' && url.pathname === '/api/events' && !/text\/event-stream/.test(req.headers.accept || '')) {
      return send(res, 200, { now: Date.now(), events: await currentEvents() })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(payload())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const { sessionId } = await readJson(req)
      // The link is rebuilt server-side from the queue; the client never supplies a URL.
      const row = (await allRows()).find((r) => r.sessionId === sessionId) || (await findInTree(sessionId))
      if (!row) return send(res, 404, { error: 'not in queue' })
      if (!row.link) return send(res, 409, { error: 'terminal session: no desktop app session to open' })
      await openUrl(row.link)
      return send(res, 200, { ok: true, url: row.link, dryRun: DRY_OPEN })
    }
    if (req.method === 'POST' && url.pathname === '/api/new') {
      const { sessionId, role, parent } = await readJson(req)
      if (!isNewSessionRole(role)) return send(res, 400, { error: 'unknown role' })
      // A new session in the selected row's repo, or a plain new session with nothing selected.
      // As with open, the folder comes from the queue on this side; the client never sends a path,
      // and the prompt is only ever a role tag built here from a validated role.
      const row = sessionId ? (await allRows()).find((r) => r.sessionId === sessionId) : null
      const folder = await usableFolder(row?.folder)
      const marker = roleMarker(role, parent)
      // Managers and the interface also get one line saying where to learn the job; only the tag is parsed.
      const prompt = rolePrompt(role, parent, ROSTER_FILE)
      const link = newSessionLink(folder, prompt)
      await openUrl(link)
      return send(res, 200, { ok: true, url: link, folder, marker, prompt, dryRun: DRY_OPEN })
    }
    if (req.method === 'GET' && url.pathname === '/api/claims') return send(res, 200, { now: Date.now(), claims: await currentClaims() })
    if (req.method === 'GET' && url.pathname === '/api/tree') return send(res, 200, await currentTree())
    if (req.method === 'POST' && url.pathname === '/api/classify') {
      const { sessionId, role, parent } = await readJson(req)
      await setRole(sessionId, role || NO_ROLE, parent || '') // empty = the `x` key: explicitly no role
      await writeRoster().catch((e) => console.error('roster failed:', e.message))
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/rename') {
      const { sessionId, name } = await readJson(req)
      await setOverlay(sessionId, name)
      await tick()
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && ['/api/park', '/api/unpark', '/api/done'].includes(url.pathname)) {
      const body = await readJson(req)
      if (url.pathname === '/api/park') await parkSession(body.sessionId, body)
      else if (url.pathname === '/api/unpark') await unparkSession(body.sessionId)
      else await setDone(body.sessionId, body.done !== false)
      await Promise.all([tick(), writeRoster().catch((e) => console.error('roster failed:', e.message))])
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const file = path.join(PUBLIC, rel)
      if (path.dirname(file) !== PUBLIC || !TYPES[path.extname(file)]) return send(res, 404, { error: 'not found' })
      return send(res, 200, await fsp.readFile(file), TYPES[path.extname(file)])
    }
    send(res, 404, { error: 'not found' })
  } catch (e) {
    send(res, e.status || (e.code === 'ENOENT' ? 404 : 500), { error: e.code === 'ENOENT' ? 'not found' : String(e.message) })
  }
})

await tick()
setInterval(tick, 1000).unref?.()
writeRoster().catch(() => {})
setInterval(() => writeRoster().catch((e) => console.error('roster failed:', e.message)), 5000).unref?.()
setInterval(() => { for (const c of clients) c.write(': hb\n\n') }, 15000).unref?.()
server.listen(PORT, HOST, () => console.log(`Zarvis → http://${HOST}:${PORT}${DRY_OPEN ? '  (dry-open)' : ''}`))
