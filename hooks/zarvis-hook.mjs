#!/usr/bin/env node
/**
 * Claude Code hook for Zarvis. Not run by the server: point your settings.json at it
 * (see README). `set` marks the session blocked; the other modes track whether it is working.
 *
 *   Notification (matcher permission_prompt) -> `set`    blocked marker
 *   UserPromptSubmit                         -> `start`  working marker, clock restarts
 *   PreToolUse / PermissionDenied            -> `resume` blocked marker off, working on
 *   PostToolUse                              -> `work`   working marker refreshed (clock kept)
 *   Stop / SessionStart                      -> `idle`   blocked marker off, working marker says idle
 *   SessionEnd                               -> `done`   both markers off
 *
 * Reads the hook payload (JSON) from stdin. Writes ONLY under ~/.zarvis/blocked/ and working/.
 * The transcript is read (never written) to find which tool is waiting, because the
 * Notification payload only carries a sentence like "Claude needs your permission to use Bash".
 * Never throws and never prints: a hook must not disturb the session.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.ZARVIS_HOME || path.join(os.homedir(), '.zarvis')
const DIR = path.join(HOME, 'blocked')
const WORKING_DIR = path.join(HOME, 'working')
const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/
const TAIL_BYTES = 256 * 1024

/** One-line summary of a tool_use input. */
export function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const pick = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.description
  if (typeof pick === 'string') return pick.slice(0, 1000)
  try {
    return JSON.stringify(input).slice(0, 1000)
  } catch {
    return ''
  }
}

/** The last tool_use in a transcript tail that has no tool_result after it. */
export function pendingTool(tailText) {
  const lines = tailText.split('\n')
  const answered = new Set()
  for (let i = lines.length - 1; i >= 0; i--) {
    let r
    try {
      r = JSON.parse(lines[i])
    } catch {
      continue // partial first line of the tail, or junk
    }
    const content = r?.message?.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const p = content[j]
      if (p?.type === 'tool_result' && p.tool_use_id) answered.add(p.tool_use_id)
      if (p?.type === 'tool_use' && !answered.has(p.id)) {
        return { tool: String(p.name || ''), command: summarizeInput(p.name, p.input) }
      }
    }
  }
  return { tool: '', command: '' }
}

async function readTail(file) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Build the marker for a Notification payload. Exported for tests. */
export async function buildMarker(payload, now = Date.now()) {
  let tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  let command = ''
  if (payload.tool_input) command = summarizeInput(tool, payload.tool_input)
  if (!command && typeof payload.transcript_path === 'string') {
    try {
      const p = pendingTool(await readTail(payload.transcript_path))
      tool = tool || p.tool
      command = p.command
    } catch {
      /* transcript unreadable: the message text still says what happened */
    }
  }
  if (!tool && typeof payload.message === 'string') {
    tool = /use (\S+)/.exec(payload.message)?.[1] || ''
  }
  return {
    sessionId: payload.session_id,
    at: now,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    message: typeof payload.message === 'string' ? payload.message.slice(0, 2000) : '',
    tool,
    command,
    transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : '',
  }
}

/** The working marker for a payload. `prev` keeps the turn's start time across refreshes. */
export function buildWorking(payload, prev, now = Date.now(), state = 'working') {
  const at = Number(prev?.at)
  // The clock carries over only while the state does: working -> working keeps the turn start.
  const keep = Number.isFinite(at) && at > 0 && (prev?.state ?? 'working') === state
  return {
    sessionId: payload.session_id,
    state,
    at: keep ? at : now,
    seen: now,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : '',
  }
}

async function writeAtomic(file, marker) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(marker))
  await fsp.rename(tmp, file)
}

async function main() {
  const mode = process.argv[2]
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  let payload
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return
  }
  const id = payload?.session_id
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return
  const file = path.join(DIR, `${id}.json`)
  const workFile = path.join(WORKING_DIR, `${id}.json`)
  if (mode === 'set') {
    await writeAtomic(file, await buildMarker(payload))
  } else if (mode === 'clear') {
    await fsp.rm(file, { force: true })
  } else if (mode === 'done') {
    await Promise.all([fsp.rm(file, { force: true }), fsp.rm(workFile, { force: true })])
  } else if (mode === 'idle') {
    await fsp.rm(file, { force: true })
    await writeAtomic(workFile, buildWorking(payload, null, Date.now(), 'idle'))
  } else if (mode === 'start' || mode === 'resume' || mode === 'work') {
    let prev = null
    if (mode !== 'start') {
      try {
        prev = JSON.parse(await fsp.readFile(workFile, 'utf8'))
      } catch {
        /* first sign of life for this session */
      }
    }
    if (mode !== 'work') await fsp.rm(file, { force: true })
    await writeAtomic(workFile, buildWorking(payload, prev))
  }
}

// Only run when executed directly, so tests can import the helpers.
if (process.argv[1]?.endsWith('zarvis-hook.mjs')) {
  main().catch(() => {})
}
