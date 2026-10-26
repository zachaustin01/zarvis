#!/usr/bin/env node
/**
 * Claude Code hook for Zarvis. Not run by the server: point your settings.json at it
 * (see README). `set` marks the session blocked; the other modes track whether it is working.
 *
 *   PermissionRequest                        -> `set`    blocked marker, at once, with tool and input
 *   Notification (matcher permission_prompt) -> `set`    blocked marker (the same prompt, ~6 s later)
 *   UserPromptSubmit                         -> `start`  working marker, clock restarts
 *   PreToolUse / PermissionDenied            -> `resume` blocked marker off, working on
 *   PostToolUse                              -> `work`   working marker refreshed (clock kept)
 *   Stop / SessionStart                      -> `idle`   blocked marker off, working marker says idle; but if the turn
 *                                                       ended on a question for the user (see askedQuestion), a blocked
 *                                                       marker with kind "question" is written instead
 *   SessionEnd                               -> `done`   both markers off
 *   SubagentStop                             -> `agentstop` blocked marker off if that subagent owned it
 *   PreToolUse (second entry, timeout 5)     -> `guard`  claim the checkout a write / git command touches, or ASK when another live session holds it
 *   PostToolUse (second entry, timeout 5)    -> `guardpost` an allowed ask joins the claim's sharers
 *   (SessionEnd `done` also releases the session's checkout claims; see lib/claims.mjs)
 *
 * Subagents: their tool events and permission prompts carry the PARENT's session_id plus `agent_id`.
 * The parent is the visible session, so a subagent's prompt blocks the parent. But an event from a
 * subagent never clears a marker it did not write (parallel agents, or a main-thread prompt), never
 * writes idle, and a Stop/idle from the parent leaves a subagent's prompt standing (it is still pending).
 *
 * `start` also registers a role when the session's FIRST prompt begins with `[zarvis: role=manager]`
 * (or interface / worker, optionally `parent=<session id>`); the same text elsewhere is ignored.
 *
 * Reads the hook payload (JSON) from stdin. Writes ONLY under ~/.zarvis/blocked/, working/, roles/ and claims/.
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
const ROLES_DIR = path.join(HOME, 'roles')
const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/
const TAIL_BYTES = 256 * 1024
const GUARD_TIMEOUT_MS = 400 // the claim guard runs before every tool call: past this it gives up silently

/** One-line summary of a tool_use input. */
export function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    return input.questions
      .map((q) => [q?.question, ...(Array.isArray(q?.options) ? q.options.map((o) => `  • ${o?.label}`) : [])].join('\n'))
      .join('\n\n')
      .slice(0, 1500)
  }
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

const WRAP_UP = 'mcp__ccd_turn__wrap_up'

/**
 * The question the final turn ended with, or null. Walks the transcript tail backwards to the last
 * tool_use of the turn: it counts only when that is the desktop app's wrap_up with a non-empty `ask`
 * (a recap alone asks nothing) or AskUserQuestion that nothing has answered, and no real user message
 * came after it. A real user message (not a tool_result, not a meta/injected one) ends the search, so
 * an older wrap_up never counts. Subagent (sidechain) records are ignored.
 */
export function askedQuestion(tailText) {
  const lines = String(tailText).split('\n')
  const answered = new Set()
  for (let i = lines.length - 1; i >= 0; i--) {
    let r
    try {
      r = JSON.parse(lines[i])
    } catch {
      continue // partial first line of the tail, or a half-written last line
    }
    if (!r || typeof r !== 'object' || r.isSidechain) continue
    const content = r.message?.content
    if (r.type === 'user' && !r.isMeta) {
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
      for (const p of parts) if (p?.type === 'tool_result' && p.tool_use_id) answered.add(p.tool_use_id)
      if (parts.some((p) => p?.type === 'text' && String(p.text ?? '').trim())) return null // the user replied
      continue
    }
    if (r.type !== 'assistant' || !Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const p = content[j]
      if (p?.type !== 'tool_use') continue
      if (p.name === WRAP_UP) {
        const ask = typeof p.input?.ask === 'string' ? p.input.ask.trim() : ''
        return ask ? { tool: p.name, ask: ask.slice(0, 1500) } : null
      }
      if (p.name === 'AskUserQuestion' && !answered.has(p.id)) {
        const text = summarizeInput(p.name, p.input)
        return text ? { tool: p.name, ask: text } : null
      }
      return null // the turn's last tool call was something else
    }
  }
  return null
}

/** The blocked marker for a session whose turn ended waiting on the user's answer. Exported for tests. */
export function buildQuestionMarker(payload, q, now = Date.now()) {
  return {
    sessionId: payload.session_id,
    kind: 'question',
    at: now,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    message: 'Waiting for your answer',
    tool: '',
    command: q.ask,
    transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : '',
  }
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
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id.slice(0, 100) : ''
  if (!command && typeof payload.transcript_path === 'string') {
    try {
      // transcript_path is always the session's; a subagent's own tool calls live beside it.
      const file = agentId && SAFE_ID.test(agentId.replace(/^agent-/, '')) ? agentTranscript(payload.transcript_path, agentId) : payload.transcript_path
      const p = pendingTool(await readTail(file))
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
    ...(agentId ? { agentId, agentType: typeof payload.agent_type === 'string' ? payload.agent_type.slice(0, 100) : '' } : {}),
  }
}

/** Where a subagent's transcript lives: `<session>/subagents/agent-<id>.jsonl` beside the session's. */
export function agentTranscript(transcriptPath, agentId) {
  return path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId.replace(/^agent-/, '')}.jsonl`)
}

/**
 * Merge a Notification into the marker a PermissionRequest already wrote for the same prompt: the
 * request carried the tool, input and agent; the notification only has a sentence and the session's
 * transcript (whose pending tool is the parent's Agent call, not the subagent's command).
 */
export function mergeNotification(prev, next) {
  if (!prev || !prev.tool || !prev.command || next.agentId) return next
  return { ...next, tool: prev.tool, command: prev.command, ...(prev.agentId ? { agentId: prev.agentId, agentType: prev.agentType || '' } : {}) }
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

/**
 * The role tag for a UserPromptSubmit payload, or null. Exported for tests. Only a tag at the very
 * start of the prompt counts (leading whitespace allowed), as `rolePrompt` generates it; a brief or
 * conversation that merely mentions the tag mid-text must not register a role. The caller also
 * checks that this is the session's first prompt.
 */
export function buildRoleTag(payload, now = Date.now()) {
  const m = /^\s*\[zarvis:\s*role=(interface|manager|worker)(?:\s+parent=([A-Za-z0-9_-]{8,80}))?\s*\]/i.exec(typeof payload.prompt === 'string' ? payload.prompt : '')
  return m ? { sessionId: payload.session_id, role: m[1].toLowerCase(), parent: m[2] || '', at: now } : null
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The claim guard: prints at most one `ask` decision, never a deny. Any error or the self-timeout prints
 * nothing and exits 0, which changes nothing about the tool call.
 */
async function guardMode(mode, payload) {
  const claims = await import('../lib/claims.mjs')
  const ctx = { home: HOME, now: Date.now(), deps: claims.realDeps, self: () => claims.sessionProcess({}), name: (sid) => claims.sessionName(sid) }
  if (mode === 'guardpost') return claims.guardPost(payload, ctx)
  const out = claims.guard(payload, ctx)
  if (out) process.stdout.write(JSON.stringify(out))
}

let guardTimer = null

async function main() {
  const mode = process.argv[2]
  const guarding = mode === 'guard' || mode === 'guardpost'
  if (guarding) guardTimer = setTimeout(() => process.exit(0), GUARD_TIMEOUT_MS)
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
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : ''
  if (guarding) {
    try {
      await guardMode(mode, payload)
    } catch {
      /* a failed guard must not disturb the session */
    }
    return
  }
  if (mode === 'set') {
    const next = await buildMarker(payload)
    const prev = await readJson(file)
    await writeAtomic(file, payload.hook_event_name === 'Notification' ? mergeNotification(prev, next) : next)
  } else if (mode === 'agentstop') {
    // A subagent finished: if its own prompt is the pending one, that prompt is gone.
    if (agentId && (await readJson(file))?.agentId === agentId) await fsp.rm(file, { force: true })
  } else if (mode === 'clear') {
    await fsp.rm(file, { force: true })
  } else if (mode === 'done') {
    await Promise.all([fsp.rm(file, { force: true }), fsp.rm(workFile, { force: true })])
    try {
      ;(await import('../lib/claims.mjs')).releaseSession(HOME, id)
    } catch {
      /* the claims are best effort; they also expire */
    }
  } else if (mode === 'idle') {
    if (agentId) return // a subagent's lifecycle event says nothing about the visible session
    // A turn can end while a background subagent still waits on a prompt: that prompt stands.
    if (!(await readJson(file))?.agentId) {
      let q = null
      if (typeof payload.transcript_path === 'string' && payload.hook_event_name !== 'SessionStart') {
        try {
          q = askedQuestion(await readTail(payload.transcript_path))
        } catch {
          /* transcript missing or unreadable: plain idle */
        }
      }
      if (q) await writeAtomic(file, buildQuestionMarker(payload, q))
      else await fsp.rm(file, { force: true })
    }
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
    if (mode === 'start') {
      // "First prompt" = we are the first `start` to claim the `<id>.first` sentinel (wx write).
      // The working marker can't tell us: SessionStart's idle writes one before any prompt, and
      // idle/work/resume rewrite it. The sentinel is not .json, so the server's role reader skips it.
      await fsp.mkdir(ROLES_DIR, { recursive: true })
      let first = false
      try {
        await fsp.writeFile(path.join(ROLES_DIR, `${id}.first`), '', { flag: 'wx' })
        first = true
      } catch {
        /* a later prompt */
      }
      const tag = first ? buildRoleTag(payload) : null
      if (tag) {
        try {
          await fsp.writeFile(path.join(ROLES_DIR, `${id}.json`), JSON.stringify(tag), { flag: 'wx' })
        } catch {
          /* already tagged: the first marker wins */
        }
      }
    }
    if (mode !== 'work') {
      // Another agent's tool call must not clear a prompt it did not raise; the raising agent's own
      // next event (it got its answer) does, and so does a new prompt.
      const blocked = await readJson(file)
      if (mode === 'start' || !blocked || (blocked.agentId || '') === agentId) await fsp.rm(file, { force: true })
    }
    await writeAtomic(workFile, buildWorking(payload, prev))
  }
}

// Only run when executed directly, so tests can import the helpers.
if (process.argv[1]?.endsWith('zarvis-hook.mjs')) {
  main().catch(() => {}).finally(() => clearTimeout(guardTimer))
}
