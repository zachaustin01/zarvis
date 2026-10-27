// Scheduled jobs Zarvis shows on the Schedule view: ~/.zarvis/schedules.json, written by `npm run schedule`
// (lib/schedule-cli.mjs). Zarvis only displays them; it never runs or edits anyone's jobs. A job is
// { name, cron, note, link, source, owner, addedAt }; `owner` is the session that registered it, { session, app } (the CLI
// session id and the desktop app's local_ id, either may be ''), or null for a job nobody owns (a system cron job). Everything is validated on write AND on read, so a hand-edited or
// corrupt file just yields the jobs that are valid (or none).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { cleanCron } from './cron.mjs'
import { cleanUrl, fileUrlOf } from './links.mjs'
import { SAFE_ID } from './markers.mjs'
import { DESKTOP_ID } from './sessions.mjs'

export const MAX_JOBS = 40
export const MAX_NAME = 60
export const MAX_NOTE = 200
export const SOURCES = ['manual', 'claude']

// eslint-disable-next-line no-control-regex
const ONE_LINE = /[\u0000-\u001f\u007f-\u009f\s]+/g
const line = (raw, max) => String(raw ?? '').replace(ONE_LINE, ' ').trim().slice(0, max).trim()

export const schedulesFile = (home) => path.join(home, 'schedules.json')

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

/** A validated { session, app } owner, or null. */
export function parseOwner(raw) {
  if (!raw || typeof raw !== 'object') return null
  const session = typeof raw.session === 'string' && SAFE_ID.test(raw.session) ? raw.session : ''
  const app = typeof raw.app === 'string' && DESKTOP_ID.test(raw.app) ? raw.app : ''
  return session || app ? { session, app } : null
}

/** One validated job, or null. Name and cron are required; note, link and source are optional. */
export function parseJob(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || raw.name.length > MAX_NAME || /[\r\n]/.test(raw.name)) return null
  const name = line(raw.name, MAX_NAME)
  const cron = cleanCron(raw.cron)
  if (!name || !cron) return null
  const link = raw.link ? cleanUrl(raw.link) : ''
  const source = SOURCES.includes(raw.source) ? raw.source : 'manual'
  const addedAt = Number.isFinite(raw.addedAt) && raw.addedAt > 0 ? Math.floor(raw.addedAt) : 0
  return { name, cron, note: line(raw.note, MAX_NOTE), link, source, owner: parseOwner(raw.owner), addedAt }
}

/** Stored jobs, oldest first, names unique (the last wins), at most MAX_JOBS. Never throws. */
export async function readJobs(home) {
  try {
    const o = JSON.parse(await fsp.readFile(schedulesFile(home), 'utf8'))
    const seen = new Map()
    for (const j of (Array.isArray(o?.jobs) ? o.jobs : []).map(parseJob).filter(Boolean)) seen.set(j.name.toLowerCase(), j)
    return [...seen.values()].slice(0, MAX_JOBS)
  } catch {
    return []
  }
}

async function write(home, jobs) {
  const file = schedulesFile(home)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ jobs }, null, 2))
  await fsp.rename(tmp, file)
}

function checked({ name, cron, note = '', link = '', owner = null }, cwd) {
  if (typeof name !== 'string' || !line(name, 1000)) throw refuse('a job needs a name')
  if (line(name, 1000).length > MAX_NAME || /[\r\n]/.test(name)) throw refuse(`name must be one line of at most ${MAX_NAME} characters`)
  if (!cleanCron(cron)) throw refuse(`not a valid 5-field cron: "${cron}"`)
  if (line(note, 100000).length > MAX_NOTE) throw refuse(`note must be at most ${MAX_NOTE} characters`)
  let url = ''
  if (link) {
    url = cleanUrl(fileUrlOf(link, cwd) || link)
    if (!url) throw refuse('not a safe link: use a single http(s):// URL or an absolute file path (max 300 characters, no spaces, no user:password@)')
  }
  if (owner && !parseOwner(owner)) throw refuse('not a valid owner session')
  return { name, cron, note, link: url, owner }
}

/**
 * Add a job, or replace the one with the same name (case-insensitive; the whole job is replaced, so pass `owner` again
 * to keep it tied to a session). Throws an Error with `.refusal` for bad input or a full store. `link` may be an
 * http(s) URL or a file path (resolved against `cwd`); `owner` is { session, app } from the CLI's --by.
 */
export async function addJob(home, input, { now = Date.now(), cwd = process.cwd() } = {}) {
  const job = parseJob({ ...checked(input, cwd), source: 'manual', addedAt: now })
  const prev = await readJobs(home)
  const same = prev.findIndex((j) => j.name.toLowerCase() === job.name.toLowerCase())
  if (same < 0 && prev.length >= MAX_JOBS) throw refuse(`already ${MAX_JOBS} schedules: remove one first`)
  if (same >= 0) prev.splice(same, 1)
  await write(home, [...prev, job])
  return job
}

/** Change fields of an existing job in place (cron, note, link, owner; `owner: null` clears it). Returns the new job or null. */
export async function setJob(home, name, patch, { cwd = process.cwd() } = {}) {
  const prev = await readJobs(home)
  const at = prev.findIndex((j) => j.name.toLowerCase() === String(name ?? '').trim().toLowerCase())
  if (at < 0) return null
  const old = prev[at]
  const merged = checked({ name: old.name, cron: patch.cron ?? old.cron, note: patch.note ?? old.note, link: patch.link === undefined ? old.link : patch.link, owner: patch.owner === undefined ? old.owner : patch.owner }, cwd)
  prev[at] = parseJob({ ...merged, source: old.source, addedAt: old.addedAt })
  await write(home, prev)
  return prev[at]
}

/** Remove by name (case-insensitive). Returns the removed job or null. */
export async function removeJob(home, name) {
  const prev = await readJobs(home)
  const at = prev.findIndex((j) => j.name.toLowerCase() === String(name ?? '').trim().toLowerCase())
  if (at < 0) return null
  const [gone] = prev.splice(at, 1)
  await write(home, prev)
  return gone
}
