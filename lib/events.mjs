// Pushed events: any session or script appends one JSON line to ~/.zarvis/events.jsonl and the ticker shows it.
// Line format: {"at":ms,"sessionId"?:"…","kind":"push","text":"…","url"?:"https://…"}.
//
// Concurrency: an append is ONE appendFile of ONE short line (< 1 KB) on a file opened O_APPEND. POSIX makes each
// such write land whole at the end of the file on a local filesystem, so concurrent appenders do not interleave.
// That guarantee does not hold on NFS or other network filesystems, and the reader skips any torn line anyway.
// Rotation takes no lock: the trimmer renames the file away (atomic, one winner), then appends the newest lines
// back to a fresh events.jsonl. A line written in the instant between the rename and the re-append lands in the new
// file; only an appender that had the old file open at that very moment could lose its line.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SAFE_ID, zarvisHome, shellSegments, gitInvocations, readBranch, findRoot } from './claims.mjs'

export const MAX_TEXT = 200
export const MAX_URL = 300
export const MAX_KIND = 20
export const KEEP_EVENTS = 500 // a rotation keeps this many
export const TRIM_LINES = 1000 // …once the file holds more lines than this
const TRIM_CHECK_BYTES = 192 * 1024 // below this size the file is not even read to count lines
const TAIL_BYTES = 256 * 1024
export const KINDS = ['push', 'pr', 'info', 'done', 'warn']

export const eventsFile = (home = zarvisHome()) => path.join(home, 'events.jsonl')

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

/** One line of plain text: control characters (newlines, escapes, DEL) become spaces, runs collapse, capped. */
export const oneLine = (v, max) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/** http(s) URL or ''. Throws on a URL that is present but unusable (CLI arguments); `lenient` returns '' instead (file reads). */
export function cleanUrl(v, lenient = false) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  let ok = s.length <= MAX_URL && !/[\u0000- \u007f-\u009f]/.test(s)
  if (ok) {
    try {
      ok = /^https?:$/.test(new URL(s).protocol)
    } catch {
      ok = false
    }
  }
  if (ok) return s
  if (lenient) return ''
  throw refuse(`--url must be an http(s) URL of at most ${MAX_URL} characters, without spaces`)
}

export function cleanKind(v, lenient = false) {
  const k = String(v ?? '').trim().toLowerCase() || 'info'
  if (/^[a-z][a-z0-9_-]{0,19}$/.test(k)) return k
  if (lenient) return 'info'
  throw refuse(`--kind must be one word of at most ${MAX_KIND} letters, digits, - or _`)
}

/** Build a stored event from raw fields (CLI/auto). Throws a refusal on bad input. */
export function buildEvent({ text, kind, url, sessionId } = {}, now = Date.now()) {
  const t = oneLine(text, MAX_TEXT)
  if (!t) throw refuse('an event needs text')
  const ev = { at: now, ...(sessionId && SAFE_ID.test(sessionId) ? { sessionId } : {}), kind: cleanKind(kind), text: t }
  const u = cleanUrl(url)
  if (u) ev.url = u
  return ev
}

/** A parsed line from the file, re-validated (never trust the file), or null. */
export function parseEvent(line) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const at = Number(o.at)
  const text = oneLine(o.text, MAX_TEXT)
  if (!Number.isFinite(at) || at <= 0 || !text) return null
  const ev = { at, kind: cleanKind(o.kind, true), text }
  if (typeof o.sessionId === 'string' && SAFE_ID.test(o.sessionId)) ev.sessionId = o.sessionId
  const url = cleanUrl(typeof o.url === 'string' ? o.url : '', true)
  if (url) ev.url = url
  return ev
}

export const eventKey = (e) => `${e.at}|${e.sessionId || ''}|${e.text}`

/** Append one event. Rotates when the file has grown past TRIM_LINES lines. Returns the event. */
export async function appendEvent(home, ev) {
  const file = eventsFile(home)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.appendFile(file, `${JSON.stringify(ev)}\n`)
  await maybeTrim(file).catch(() => {})
  return ev
}

/** Keep the newest KEEP_EVENTS lines once the file exceeds TRIM_LINES. See the header for why no lock is needed. */
export async function maybeTrim(file, { keep = KEEP_EVENTS, limit = TRIM_LINES, checkBytes = TRIM_CHECK_BYTES } = {}) {
  const st = await fsp.stat(file)
  if (st.size < checkBytes) return false
  const text = await fsp.readFile(file, 'utf8')
  if (text.split('\n').length - 1 <= limit) return false
  const away = `${file}.rot.${process.pid}.${Math.random().toString(36).slice(2)}`
  try {
    await fsp.rename(file, away) // atomic: of several trimmers one wins, the rest see ENOENT
  } catch {
    return false
  }
  try {
    const lines = (await fsp.readFile(away, 'utf8')).split('\n').filter((l) => l.trim())
    // The reader sorts by time, so lines that arrived in the new file meanwhile need not stay "after" these.
    await fsp.appendFile(file, `${lines.slice(-keep).join('\n')}\n`)
  } finally {
    await fsp.rm(away, { force: true })
  }
  return true
}

/** The newest `limit` valid events (oldest first), de-duplicated by (at, sessionId, text). Reads only the file's tail. Never throws. */
export function readEvents(home = zarvisHome(), limit = 50) {
  let text
  try {
    const fd = fs.openSync(eventsFile(home), 'r')
    try {
      const { size } = fs.fstatSync(fd)
      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      text = buf.toString('utf8')
      if (size > len) text = text.slice(text.indexOf('\n') + 1) // the first line of the tail is cut
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
  const seen = new Set()
  const out = []
  for (const line of text.split('\n')) {
    const ev = line ? parseEvent(line) : null
    if (!ev || seen.has(eventKey(ev))) continue
    seen.add(eventKey(ev))
    out.push(ev)
  }
  return out.sort((a, b) => a.at - b.at).slice(-limit)
}

// --- automatic events from the PostToolUse hook ---

/** Auto events are on unless ZARVIS_AUTO_EVENTS=0 or state.json has autoEvents:false. Sync and cheap (the hook calls it). */
export function autoEventsEnabled(home = zarvisHome(), env = process.env) {
  if (String(env.ZARVIS_AUTO_EVENTS ?? '').trim() === '0') return false
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))?.autoEvents !== false
  } catch {
    return true
  }
}

const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const BAD_OUTPUT = /(^|\n)\s*(error: failed to push|! \[(remote )?rejected\]|fatal:|error: src refspec|remote: error)/i

const textOf = (v) => (typeof v === 'string' ? v : '')
function responseText(r) {
  if (typeof r === 'string') return r
  if (!r || typeof r !== 'object') return ''
  return [textOf(r.stdout), textOf(r.stderr), textOf(r.output), textOf(r.content)].filter(Boolean).join('\n')
}

/** Did the tool call run to completion without an error? PostToolUse only fires on success, but check what the payload says too. */
export function toolSucceeded(resp) {
  if (resp && typeof resp === 'object') {
    if (resp.interrupted === true || resp.is_error === true || resp.isError === true || resp.success === false) return false
    for (const k of ['exitCode', 'exit_code', 'returncode']) if (k in resp && Number(resp[k]) !== 0) return false
  }
  return true
}

/** `refs/heads/x` / `+x:y` / `HEAD:refs/heads/y` -> the branch the push targets ('' if it cannot be said). */
function refspecBranch(spec) {
  const dst = spec.replace(/^\+/, '').split(':').pop()
  return dst.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, 'tag ')
}

/** "pushed x to origin" events for every `git push` in a Bash command that succeeded. Best effort, no spawns. */
export function pushEvents(command, cwd, output = '') {
  const out = []
  for (const g of gitInvocations(command, cwd || process.cwd())) {
    if (g.sub !== 'push' || g.args.some((a) => a === '--dry-run' || a === '-n' || a === '--delete' || a === '-d')) continue
    if (/(^|\n)Everything up-to-date/i.test(output)) continue
    const pos = []
    let all = ''
    for (let i = 0; i < g.args.length; i++) {
      const a = g.args[i]
      if (PUSH_VALUE_FLAGS.has(a)) i++
      else if (a === '--all' || a === '--mirror') all = a === '--all' ? 'all branches' : 'all refs'
      else if (a === '--tags') all = all || 'tags'
      else if (!a.startsWith('-')) pos.push(a)
    }
    const remote = oneLine(pos[0] || '', 60)
    let branch = all
    if (!branch && pos[1]) branch = refspecBranch(pos[1])
    if (!branch || branch === 'HEAD') {
      const root = findRoot(g.dir)
      branch = (root && readBranch(root)) || ''
    }
    if (!branch) branch = oneLine(/(\S+) -> \S+/.exec(output)?.[1] || '', 80)
    out.push({ kind: 'push', text: ['pushed', branch, remote && `to ${remote}`].filter(Boolean).join(' ') })
  }
  return out
}

/** Every `gh pr create` in a command. */
export function prEvents(command, output = '') {
  const out = []
  for (const words of shellSegments(command)) {
    const i = words.findIndex((w) => w.split('/').pop() === 'gh')
    if (i < 0 || words[i + 1] !== 'pr' || words[i + 2] !== 'create') continue
    if (words.includes('--help') || words.includes('-h')) continue
    const urls = output.match(/https?:\/\/[^\s)>"']+\/pull\/\d+/g)
    const ev = { kind: 'pr', text: 'opened a PR' }
    if (urls?.length) ev.url = cleanUrl(urls[urls.length - 1], true)
    out.push(ev)
  }
  return out
}

/**
 * The events a PostToolUse payload implies: [] unless it is a successful Bash call running `git push` or
 * `gh pr create`. Pure (no I/O besides reading .git/HEAD for a branch name).
 */
export function autoEventsFor(payload) {
  if (!payload || payload.tool_name !== 'Bash') return []
  const command = textOf(payload.tool_input?.command)
  if (!/\bgit\b[^|;&\n]*\bpush\b|\bgh\b[^|;&\n]*\bpr\b[^|;&\n]*\bcreate\b/.test(command)) return []
  if (!toolSucceeded(payload.tool_response)) return []
  const output = responseText(payload.tool_response)
  if (BAD_OUTPUT.test(output)) return []
  const cwd = textOf(payload.cwd) || undefined
  return [...pushEvents(command, cwd, output), ...prEvents(command, output)]
}

/** Hook entry point: append the auto events for a payload. Never throws. */
export async function logAutoEvents(payload, home = zarvisHome(), now = Date.now(), env = process.env) {
  try {
    if (!autoEventsEnabled(home, env)) return []
    const sessionId = SAFE_ID.test(payload?.session_id || '') ? payload.session_id : ''
    const made = []
    for (const e of autoEventsFor(payload)) made.push(await appendEvent(home, buildEvent({ ...e, sessionId }, now)))
    return made
  } catch {
    return []
  }
}
