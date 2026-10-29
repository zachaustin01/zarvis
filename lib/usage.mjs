// Token usage per session, summed from the transcripts under ~/.claude/projects (read-only).
//
// Layout: <projects>/<encoded folder>/<session id>.jsonl, plus <projects>/<encoded folder>/<session id>/subagents/*.jsonl
// for the session's subagents (their spend belongs to the session). Each assistant line carries message.usage.
//
// Transcripts repeat assistant messages (one line per streamed content block, replays on resume), so a message is
// counted once, keyed by message id + request id, the largest output_tokens winning (streaming lines grow). A
// resumed or forked session also replays the earlier messages into its own file; the session whose transcript began
// first keeps them. `<synthetic>` messages (local errors, no API call) are skipped.
//
// Files are append-only: each is parsed once and then only from the byte after the last complete line it saw, keyed
// by path + mtime + size, so a rescan of a large history reads little. A malformed line is skipped, never thrown.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CLI_PROJECTS, UUID } from './sessions.mjs'

// An entry is a flat array (history can be 100k messages): [ts, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h]
export const E = { ts: 0, model: 1, input: 2, output: 3, cacheRead: 4, cw5: 5, cw1: 6 }

const int = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const CHUNK = 4 * 1024 * 1024

/** One transcript line -> { key, entry, cwd } or null (not an assistant message with usage). Never throws. */
export function parseLine(line) {
  if (!line.includes('"usage"')) return null
  let r
  try {
    r = JSON.parse(line)
  } catch {
    return null
  }
  const m = r?.message
  const u = m?.usage
  if (r.type !== 'assistant' || !u || typeof u !== 'object' || typeof m.model !== 'string' || m.model === '<synthetic>') return null
  const ts = Date.parse(r.timestamp)
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null
  // With a breakdown, 5m and 1h are as reported; without one every cache write is the 5-minute kind.
  const cw1 = cc ? int(cc.ephemeral_1h_input_tokens) : 0
  const cw5 = cc ? int(cc.ephemeral_5m_input_tokens) : int(u.cache_creation_input_tokens)
  const key = m.id && r.requestId ? `${m.id}|${r.requestId}` : r.uuid ? `u:${r.uuid}` : ''
  return { key, entry: [Number.isFinite(ts) ? ts : 0, m.model, int(u.input_tokens), int(u.output_tokens), int(u.cache_read_input_tokens), cw5, cw1], cwd: typeof r.cwd === 'string' ? r.cwd : '' }
}

/** A file's incremental parse state: { size, mtime, offset, entries: Map(key -> entry), loose: [entry], cwd, firstTs } */
const newFile = () => ({ size: -1, mtime: -1, offset: 0, entries: new Map(), loose: [], cwd: '', firstTs: 0 })

function addTo(f, p) {
  if (!f.cwd && p.cwd) f.cwd = p.cwd
  const ts = p.entry[E.ts]
  if (ts && (!f.firstTs || ts < f.firstTs)) f.firstTs = ts
  if (!p.key) return f.loose.push(p.entry)
  const old = f.entries.get(p.key)
  if (!old || p.entry[E.output] >= old[E.output]) f.entries.set(p.key, p.entry)
}

/** Read the file's new bytes (from `offset` to its current end) into `f`. */
async function readNew(file, f, st) {
  if (st.size < f.offset) Object.assign(f, newFile()) // it shrank: not the file we knew
  const fh = await fsp.open(file, 'r')
  try {
    let pos = f.offset
    let carry = ''
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - pos))
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (!bytesRead) break
      pos += bytesRead
      const text = carry + buf.toString('utf8', 0, bytesRead)
      const cut = text.lastIndexOf('\n')
      if (cut < 0) {
        carry = text
        continue
      }
      for (const line of text.slice(0, cut).split('\n')) {
        const p = line ? parseLine(line) : null
        if (p) addTo(f, p)
      }
      carry = text.slice(cut + 1)
      f.offset = pos - Buffer.byteLength(carry)
      await new Promise((r) => setImmediate(r)) // let the server answer other requests between chunks
    }
  } finally {
    await fh.close()
  }
  f.size = st.size
  f.mtime = st.mtimeMs
}

const readdir = (d) => fsp.readdir(d, { withFileTypes: true }).catch(() => [])

/** Every transcript under the projects dir: [{ file, sessionId, sub }]. */
export async function listTranscripts(root = CLI_PROJECTS) {
  const out = []
  for (const dir of await readdir(root)) {
    if (!dir.isDirectory()) continue
    const base = path.join(root, dir.name)
    for (const e of await readdir(base)) {
      if (e.isFile() && e.name.endsWith('.jsonl') && UUID.test(e.name.slice(0, -6))) out.push({ file: path.join(base, e.name), sessionId: e.name.slice(0, -6), sub: false })
      else if (e.isDirectory() && UUID.test(e.name)) {
        for (const s of await readdir(path.join(base, e.name, 'subagents'))) if (s.isFile() && s.name.endsWith('.jsonl')) out.push({ file: path.join(base, e.name, 'subagents', s.name), sessionId: e.name, sub: true })
      }
    }
  }
  return out
}

/**
 * A usage scanner with its own per-file cache. `refresh()` brings the cache up to date (concurrent calls share one
 * pass); `snapshot()` merges whatever is cached now: [{ sessionId, cwd, firstTs, entries: [entry] }] with every
 * message counted once. `progress` is { done, total } while a pass runs.
 */
export function createUsageScanner({ root = CLI_PROJECTS } = {}) {
  const files = new Map() // path -> parse state
  const owner = new Map() // path -> sessionId
  let running = null
  const progress = { done: 0, total: 0, running: false }

  async function pass() {
    const list = await listTranscripts(root)
    progress.total = list.length
    progress.done = 0
    progress.running = true
    const alive = new Set()
    for (const t of list) {
      alive.add(t.file)
      owner.set(t.file, t.sessionId)
      try {
        const st = await fsp.stat(t.file)
        let f = files.get(t.file)
        if (!f) files.set(t.file, (f = newFile()))
        if (f.size !== st.size || f.mtime !== st.mtimeMs) await readNew(t.file, f, st)
      } catch {
        /* vanished or unreadable mid-pass: next pass */
      }
      progress.done++
    }
    for (const k of [...files.keys()]) if (!alive.has(k)) (files.delete(k), owner.delete(k))
    progress.running = false
  }

  return {
    progress,
    refresh() {
      if (!running) running = pass().finally(() => (running = null))
      return running
    },
    snapshot() {
      const sessions = new Map() // id -> { sessionId, cwd, firstTs, parts: [file state] }
      for (const [file, f] of files) {
        const id = owner.get(file)
        if (!id) continue
        const s = sessions.get(id) || sessions.set(id, { sessionId: id, cwd: '', firstTs: 0, parts: [] }).get(id)
        s.parts.push(f)
        if (f.cwd && (!s.cwd || !file.includes(`${path.sep}subagents${path.sep}`))) s.cwd = f.cwd // the session's own file wins over a subagent's
        if (f.firstTs && (!s.firstTs || f.firstTs < s.firstTs)) s.firstTs = f.firstTs
      }
      // The earliest-started session keeps a message that several transcripts replay.
      const ordered = [...sessions.values()].sort((a, b) => (a.firstTs || Infinity) - (b.firstTs || Infinity) || a.sessionId.localeCompare(b.sessionId))
      const claimed = new Set()
      return ordered.map((s) => {
        const mine = new Map()
        const loose = []
        for (const f of s.parts) {
          for (const [k, e] of f.entries) {
            const old = mine.get(k)
            if (!old || e[E.output] > old[E.output]) mine.set(k, e)
          }
          loose.push(...f.loose)
        }
        const entries = []
        for (const [k, e] of mine) if (!claimed.has(k)) entries.push(e)
        for (const k of mine.keys()) claimed.add(k)
        return { sessionId: s.sessionId, cwd: s.cwd, firstTs: s.firstTs, entries: entries.concat(loose) }
      })
    },
  }
}
