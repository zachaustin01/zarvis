#!/usr/bin/env node
// Zarvis: read-only attention queue over Claude Code desktop sessions. Zero dependencies.
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readMarkers, WORKING_DIR, ROLES_DIR, ZARVIS_HOME } from './lib/markers.mjs'
import { classify, childrenOf, roleMarker, ROLES } from './lib/roles.mjs'
import { renderRoster } from './lib/roster.mjs'
import { scanDesktopRecords } from './lib/sessions.mjs'
import { buildQueue, applyRoles, newSessionLink, deepLinkFor, splitWorktree, DEFAULT_MAX_AGE_MS, DEFAULT_WORKING_MAX_AGE_MS } from './lib/queue.mjs'
import { readState, setOverlay, setRole } from './lib/state.mjs'

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

/** Role tags: ones the hook found in a starting prompt, overridden by hand-set ones. */
async function roleRegistry(state) {
  const tags = {}
  for (const t of await readRoleTags()) tags[t.sessionId] = { role: t.role, parent: t.parent }
  return { ...tags, ...state.roles }
}

async function readRoleTags() {
  let names = []
  try {
    names = await fsp.readdir(ROLES_DIR)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    try {
      const t = JSON.parse(await fsp.readFile(path.join(ROLES_DIR, n), 'utf8'))
      if (ROLES.includes(t.role) && `${t.sessionId}.json` === n) out.push(t)
    } catch {
      /* mid-write or junk */
    }
  }
  return out
}

async function currentQueue() {
  const [markers, working] = await Promise.all([readMarkers(), readMarkers(WORKING_DIR)])
  if (!markers.length && !working.length) return []
  const [{ records, deleted }, state] = await Promise.all([scanDesktopRecords(), readState()])
  const rows = await buildQueue({ markers, working, records, deleted, overlays: state.overlays, maxAgeMs: MAX_AGE_MS, workingMaxAgeMs: WORKING_MAX_AGE_MS })
  return applyRoles(rows, classify({ records, roles: await roleRegistry(state) }))
}

const RECENT_MS = 7 * 24 * 3600 * 1000
const STATE_RANK = { blocked: 0, waiting_on_child: 1, working: 2, idle: 3 }

/** The role tree: the interface pinned, managers with their workers, then everything unclassified. */
async function currentTree() {
  const [{ records }, state, queue] = await Promise.all([scanDesktopRecords(), readState(), currentQueue()])
  const nodes = classify({ records, roles: await roleRegistry(state) })
  const rowOf = new Map(queue.map((r) => [r.sessionId, r]))
  const kids = childrenOf(nodes)
  const now = Date.now()
  const recent = new Map(records.map((r) => [r.cliSessionId, Number(r.lastActivityAt) || Number(r.createdAt) || now]))
  const view = (n) => {
    const row = rowOf.get(n.sessionId)
    const overlay = state.overlays[n.sessionId]?.name || ''
    return {
      sessionId: n.sessionId,
      desktopSessionId: n.desktopSessionId,
      branch: row?.branch ?? '',
      link: row?.link ?? deepLinkFor(n.desktopSessionId),
      title: n.title,
      overlay,
      name: overlay || n.title,
      role: n.role,
      suggested: n.suggested,
      warnings: n.warnings,
      state: row?.state ?? 'unknown', // no hook signal: never guess
      blockedChildren: row?.blockedChildren ?? [],
      project: path.basename(splitWorktree(n.cwd).root) || '',
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
  return { interface: all.filter((n) => n.role === 'interface').map(view), managers, orphans, unclassified }
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
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// --- the roster file: every manager with its workers, for the managers themselves to read ---
const ROSTER_FILE = path.join(ZARVIS_HOME, 'roster.md')
let lastRoster = ''
async function writeRoster() {
  const text = renderRoster(await currentTree())
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
  const flat = [...t.interface, ...t.managers.flatMap((m) => [m, ...m.children]), ...t.orphans, ...t.unclassified]
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
async function tick() {
  try {
    lastQueue = await currentQueue()
    const sig = JSON.stringify(lastQueue.map(({ waitMs, ...r }) => r))
    if (sig !== lastSig) {
      lastSig = sig
      for (const c of clients) c.write(`data: ${JSON.stringify({ now: Date.now(), queue: lastQueue })}\n\n`)
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
      return send(res, 200, { now: Date.now(), queue: lastQueue })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ now: Date.now(), queue: lastQueue })}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const { sessionId } = await readJson(req)
      // The link is rebuilt server-side from the queue; the client never supplies a URL.
      const row = (await currentQueue()).find((r) => r.sessionId === sessionId) || (await findInTree(sessionId))
      if (!row) return send(res, 404, { error: 'not in queue' })
      if (!row.link) return send(res, 409, { error: 'terminal session: no desktop app session to open' })
      await openUrl(row.link)
      return send(res, 200, { ok: true, url: row.link, dryRun: DRY_OPEN })
    }
    if (req.method === 'POST' && url.pathname === '/api/new') {
      const { sessionId, role, parent } = await readJson(req)
      // A new session in the selected row's repo, or a plain new session with nothing selected.
      // As with open, the folder comes from the queue on this side; the client never sends a path,
      // and the prompt is only ever a role tag built here from a validated role.
      const row = sessionId ? (await currentQueue()).find((r) => r.sessionId === sessionId) : null
      const folder = await usableFolder(row?.folder)
      const marker = roleMarker(role, parent)
      // A manager's prompt also says where its workers are listed; only the tag is parsed.
      const prompt = role === 'manager' && marker ? `${marker} Your workers are listed in ${ROSTER_FILE}.` : marker
      const link = newSessionLink(folder, prompt)
      await openUrl(link)
      return send(res, 200, { ok: true, url: link, folder, marker, prompt, dryRun: DRY_OPEN })
    }
    if (req.method === 'GET' && url.pathname === '/api/tree') return send(res, 200, await currentTree())
    if (req.method === 'POST' && url.pathname === '/api/classify') {
      const { sessionId, role, parent } = await readJson(req)
      await setRole(sessionId, role || '', parent || '')
      await writeRoster().catch((e) => console.error('roster failed:', e.message))
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/rename') {
      const { sessionId, name } = await readJson(req)
      await setOverlay(sessionId, name)
      await tick()
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
    send(res, e.code === 'ENOENT' ? 404 : 500, { error: e.code === 'ENOENT' ? 'not found' : String(e.message) })
  }
})

await tick()
setInterval(tick, 1000).unref?.()
writeRoster().catch(() => {})
setInterval(() => writeRoster().catch((e) => console.error('roster failed:', e.message)), 5000).unref?.()
setInterval(() => { for (const c of clients) c.write(': hb\n\n') }, 15000).unref?.()
server.listen(PORT, HOST, () => console.log(`Zarvis → http://${HOST}:${PORT}${DRY_OPEN ? '  (dry-open)' : ''}`))
