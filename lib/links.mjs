// Session links: ~/.zarvis/links/<sessionId>.json, written by `npm run link` (lib/links-cli.mjs) and read by the
// server to show chips on a session's card. A link is { url, label }. URLs are untrusted (an agent chose them), so
// everything is validated on write AND on read; a bad entry, a corrupt file or a missing one just yields no links.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import { SAFE_ID } from './markers.mjs'

export const MAX_LINKS = 8
export const MAX_URL = 300
export const MAX_LABEL = 60

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

/**
 * The normalised URL, or '' when it is not safe to link to: wrong scheme, credentials, whitespace/control characters,
 * too long. http(s) only, plus `file:///absolute/path` (no host): a file link is never navigated to by the browser;
 * the server opens it on request (see openPlan).
 */
export function cleanUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL || BAD_CHARS.test(raw)) return ''
  let u
  try {
    u = new URL(raw)
  } catch {
    return ''
  }
  if (u.protocol === 'file:') {
    if (u.hostname || u.username || u.password || u.search || u.hash || /%00|%2f|%5c/i.test(u.pathname) || u.pathname.length < 2) return ''
  } else if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return ''
  return u.href.length <= MAX_URL && !BAD_CHARS.test(u.href) ? u.href : ''
}

/** One line, at most MAX_LABEL characters. */
export function cleanLabel(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ').trim().slice(0, MAX_LABEL).trim()
}

export const isFileUrl = (url) => typeof url === 'string' && url.startsWith('file:///')

const hostOf = (url) => (isFileUrl(url) ? path.basename(fileURLToPath(url)) || 'file' : new URL(url).host)

/** A `file:` URL for a path the user or agent typed: absolute, `~/…` or relative to `cwd`; null when it is not a path. */
export function fileUrlOf(arg, cwd = process.cwd(), home = os.homedir()) {
  const s = String(arg ?? '')
  if (!/^(\/|~\/|\.\.?\/)/.test(s) || s.includes('\0')) return null
  return pathToFileURL(s.startsWith('~/') ? path.join(home, s.slice(2)) : path.resolve(cwd, s)).href
}

// Opening a file runs whatever the OS associates with it (a .command or .app would execute), so only plain
// documents are opened; anything else is shown in the file manager instead.
const OPENABLE = new Set(['.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.md', '.txt', '.csv', '.tsv', '.json', '.log', '.mp4', '.mov', '.mp3', '.wav'])

/** 'open' for a plain document, 'reveal' for anything that could execute; judged on the path it is given, so call it on a symlink's real target too. */
export const modeFor = (file) => (OPENABLE.has(path.extname(file).toLowerCase()) ? 'open' : 'reveal')

/** What to do for a `file:` link: { path, mode: 'open' | 'reveal' } (reveal = show it in the file manager), or null. */
export function openPlan(url) {
  const clean = cleanUrl(url)
  if (!isFileUrl(clean)) return null
  const file = fileURLToPath(clean)
  return { path: file, mode: modeFor(file) }
}

/** One validated { url, label } (label defaults to the host), or null. */
export function parseLink(raw) {
  if (!raw || typeof raw !== 'object') return null
  const url = cleanUrl(raw.url)
  return url ? { url, label: cleanLabel(raw.label) || hostOf(url) } : null
}

export const linksFile = (home, id) => path.join(home, 'links', `${id}.json`)

/** A session's links, oldest first. Never throws; never trusts the file. */
export async function readLinks(home, id) {
  if (!SAFE_ID.test(id || '')) return []
  try {
    const o = JSON.parse(await fsp.readFile(linksFile(home, id), 'utf8'))
    return dedupe((Array.isArray(o?.links) ? o.links : []).map(parseLink).filter(Boolean))
  } catch {
    return []
  }
}

/** Every session's links: { sessionId: [link] }. */
export async function readAllLinks(home) {
  let names = []
  try {
    names = await fsp.readdir(path.join(home, 'links'))
  } catch {
    return {}
  }
  const out = {}
  for (const n of names) {
    const id = n.slice(0, -5)
    if (!n.endsWith('.json') || !SAFE_ID.test(id)) continue
    const links = await readLinks(home, id)
    if (links.length) out[id] = links
  }
  return out
}

/** Keep the last occurrence of each URL, and at most MAX_LINKS (the newest). */
function dedupe(links) {
  const seen = new Set()
  const out = []
  for (let i = links.length - 1; i >= 0; i--) {
    if (seen.has(links[i].url)) continue
    seen.add(links[i].url)
    out.unshift(links[i])
  }
  return out.slice(-MAX_LINKS)
}

async function write(home, id, links) {
  const file = linksFile(home, id)
  if (!links.length) return fsp.rm(file, { force: true })
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ sessionId: id, links }))
  await fsp.rename(tmp, file)
}

/**
 * Add (or update) a link. The same URL again moves to the end with the new label (the old label stays when none is
 * given). Returns the stored link; throws an Error with `.refusal` for an unsafe URL or id.
 */
export async function addLink(home, id, url, label = '') {
  if (!SAFE_ID.test(id || '')) throw Object.assign(new Error('bad session id'), { refusal: true })
  const clean = cleanUrl(url)
  if (!clean) throw Object.assign(new Error('not a safe link: use a single http(s):// URL or an absolute file path (max 300 characters, no spaces, no user:password@)'), { refusal: true })
  const prev = await readLinks(home, id)
  const old = prev.find((l) => l.url === clean)
  const link = { url: clean, label: cleanLabel(label) || old?.label || hostOf(clean) }
  await write(home, id, dedupe([...prev.filter((l) => l.url !== clean), link]))
  return link
}

/** Remove by URL or 1-based index. Returns the removed link or null. */
export async function removeLink(home, id, key) {
  const prev = await readLinks(home, id)
  const k = String(key ?? '').trim()
  const at = /^\d+$/.test(k) ? Number(k) - 1 : prev.findIndex((l) => l.url === cleanUrl(k))
  if (!(at >= 0 && at < prev.length)) return null
  const [gone] = prev.splice(at, 1)
  await write(home, id, prev)
  return gone
}

/** Drop a session's links (SessionEnd). */
export const clearLinks = (home, id) => fsp.rm(linksFile(home, id), { force: true })
