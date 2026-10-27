// Scheduled jobs Zarvis shows on the Schedule view: ~/.zarvis/schedules.json, written by `npm run schedule`
// (lib/schedule-cli.mjs). Zarvis only displays them; it never runs or edits anyone's jobs. A job is
// { name, cron, note, link, source, addedAt }. Everything is validated on write AND on read, so a hand-edited or
// corrupt file just yields the jobs that are valid (or none).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { cleanCron } from './cron.mjs'
import { cleanUrl, fileUrlOf } from './links.mjs'

export const MAX_JOBS = 40
export const MAX_NAME = 60
export const MAX_NOTE = 200
export const SOURCES = ['manual', 'claude']

// eslint-disable-next-line no-control-regex
const ONE_LINE = /[\u0000-\u001f\u007f-\u009f\s]+/g
const line = (raw, max) => String(raw ?? '').replace(ONE_LINE, ' ').trim().slice(0, max).trim()

export const schedulesFile = (home) => path.join(home, 'schedules.json')

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

/** One validated job, or null. Name and cron are required; note, link and source are optional. */
export function parseJob(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || raw.name.length > MAX_NAME || /[\r\n]/.test(raw.name)) return null
  const name = line(raw.name, MAX_NAME)
  const cron = cleanCron(raw.cron)
  if (!name || !cron) return null
  const link = raw.link ? cleanUrl(raw.link) : ''
  const source = SOURCES.includes(raw.source) ? raw.source : 'manual'
  const addedAt = Number.isFinite(raw.addedAt) && raw.addedAt > 0 ? Math.floor(raw.addedAt) : 0
  return { name, cron, note: line(raw.note, MAX_NOTE), link, source, addedAt }
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

/**
 * Add a job, or replace the one with the same name (case-insensitive). Throws an Error with `.refusal` for bad input
 * or a full store. `link` may be an http(s) URL or a file path (resolved against `cwd`).
 */
export async function addJob(home, { name, cron, note = '', link = '' }, { now = Date.now(), cwd = process.cwd() } = {}) {
  if (typeof name !== 'string' || !line(name, 1000)) throw refuse('a job needs a name')
  if (line(name, 1000).length > MAX_NAME || /[\r\n]/.test(name)) throw refuse(`name must be one line of at most ${MAX_NAME} characters`)
  if (!cleanCron(cron)) throw refuse(`not a valid 5-field cron: "${cron}"`)
  if (line(note, 100000).length > MAX_NOTE) throw refuse(`note must be at most ${MAX_NOTE} characters`)
  let url = ''
  if (link) {
    url = cleanUrl(fileUrlOf(link, cwd) || link)
    if (!url) throw refuse('not a safe link: use a single http(s):// URL or an absolute file path (max 300 characters, no spaces, no user:password@)')
  }
  const job = parseJob({ name, cron, note, link: url, source: 'manual', addedAt: now })
  const prev = await readJobs(home)
  const same = prev.findIndex((j) => j.name.toLowerCase() === job.name.toLowerCase())
  if (same < 0 && prev.length >= MAX_JOBS) throw refuse(`already ${MAX_JOBS} schedules: remove one first`)
  if (same >= 0) prev.splice(same, 1)
  await write(home, [...prev, job])
  return job
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
