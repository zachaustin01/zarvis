#!/usr/bin/env node
/**
 * Antigravity hook for Zarvis. Configured in ~/.gemini/config/hooks.json or an Antigravity plugin.
 * Tracks session state (working, idle, blocked on questions or permission) and integrates
 * with Zarvis's attention queue, roles, and checkout claims.
 *
 * Supported Antigravity lifecycle events:
 *   PreInvocation   -> `pre_invocation` (working marker, turn start, role tag check)
 *   PreToolUse      -> `pre_tool_use`   (refresh working marker with tool/command, checkout claim guard)
 *   PostToolUse     -> `post_tool_use`  (refresh working marker, auto-events for push/pr)
 *   Stop            -> `stop`           (idle marker; question marker if ended on ask_question)
 *   SessionStart    -> `session_start`  (initial session registration)
 *
 * Reads JSON from stdin (Antigravity camelCase protojson format).
 * Always writes valid JSON to stdout (e.g. `{}`) and exits 0. Fail-safe: never throws or crashes.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const getHome = () => process.env.ZARVIS_HOME || path.join(os.homedir(), '.zarvis')
const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/
const TAIL_BYTES = 256 * 1024
const GUARD_TIMEOUT_MS = 400

/** One-line summary of Antigravity tool arguments. */
export function summarizeAntigravityInput(name, args) {
  if (!args || typeof args !== 'object') return ''
  if (name === 'ask_question' && Array.isArray(args.questions)) {
    return args.questions
      .map((q) => {
        const prompt = q?.question || ''
        const opts = Array.isArray(q?.options)
          ? q.options.map((o) => `  • ${typeof o === 'string' ? o : o?.label || o?.text || JSON.stringify(o)}`)
          : []
        return [prompt, ...opts].join('\n')
      })
      .join('\n\n')
      .slice(0, 1500)
  }
  if (name === 'run_command') {
    const cmd = args.CommandLine ?? args.command ?? args.toolSummary
    if (typeof cmd === 'string') return cmd.slice(0, 1000)
  }
  if (name === 'write_file' || name === 'edit_file' || name === 'read_file') {
    const p = args.Path ?? args.path ?? args.file_path
    if (typeof p === 'string') return p.slice(0, 1000)
  }
  if (name === 'search_web' && typeof args.query === 'string') {
    return args.query.slice(0, 1000)
  }
  if (name === 'invoke_subagent') {
    const role = args.Role ? `[${args.Role}] ` : ''
    const p = args.Prompt || ''
    return (role + p).slice(0, 1000)
  }
  if (name === 'swarm') {
    const action = args.action || 'status'
    const target = args.name ? ` @${args.name}` : ''
    const detail = args.brief ?? args.title ?? args.model ?? ''
    return (`[swarm:${action}${target}] ${detail}`).trim().slice(0, 1000)
  }
  if (name === 'post' || name === 'post_message') {
    const ch = args.channel ? `[#${args.channel}] ` : ''
    return (ch + String(args.text ?? args.message ?? '')).trim().slice(0, 1000)
  }
  if (name === 'send_message') {
    const to = args.Recipient ? `[to:${args.Recipient}] ` : ''
    return (to + (args.Message || '')).slice(0, 1000)
  }
  const pick = args.CommandLine ?? args.Path ?? args.command ?? args.file_path ?? args.path ?? args.url ?? args.pattern ?? args.description ?? args.query
  if (typeof pick === 'string') return pick.slice(0, 1000)
  try {
    return JSON.stringify(args).slice(0, 1000)
  } catch {
    return ''
  }
}

/** Check if transcript ended with an unanswered question. */
export function askedQuestionAntigravity(tailText) {
  const lines = String(tailText).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let r
    try {
      r = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!r || typeof r !== 'object') continue
    if (r.type === 'USER_INPUT' || r.source === 'USER_EXPLICIT') {
      return null // User already answered
    }
    if (r.type === 'PLANNER_RESPONSE' && Array.isArray(r.tool_calls)) {
      for (let j = r.tool_calls.length - 1; j >= 0; j--) {
        const tc = r.tool_calls[j]
        if (tc?.name === 'ask_question') {
          const ask = summarizeAntigravityInput('ask_question', tc.args)
          return ask ? { tool: 'ask_question', ask } : null
        }
      }
      return null
    }
  }
  return null
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

/** Build working marker for Antigravity sessions. */
export function buildAntigravityWorking(payload, prev, now = Date.now(), state = 'working') {
  const at = Number(prev?.at)
  const keep = Number.isFinite(at) && at > 0 && (prev?.state ?? 'working') === state
  const toolCall = payload.toolCall
  const tool = toolCall?.name ? String(toolCall.name) : (prev?.tool || '')
  const command = toolCall ? summarizeAntigravityInput(toolCall.name, toolCall.args) : (prev?.command || '')
  const cwd = typeof payload.cwd === 'string'
    ? payload.cwd
    : (Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] || '' : '')

  return {
    sessionId: payload.conversationId,
    runtime: 'antigravity',
    state,
    at: keep ? at : now,
    seen: now,
    cwd,
    tool: tool.slice(0, 100),
    command: command.slice(0, 2000),
    transcriptPath: typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '',
  }
}

/** Question marker for Antigravity session waiting on user response. */
export function buildAntigravityQuestionMarker(payload, q, now = Date.now()) {
  const cwd = typeof payload.cwd === 'string'
    ? payload.cwd
    : (Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] || '' : '')
  return {
    sessionId: payload.conversationId,
    runtime: 'antigravity',
    kind: 'question',
    at: now,
    cwd,
    message: 'Waiting for your answer',
    tool: q.tool || '',
    command: q.ask || '',
    transcriptPath: typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '',
  }
}

/** Blocked marker for Antigravity session waiting on tool permission. */
export function buildAntigravityBlockedMarker(payload, reason = 'Antigravity needs permission', now = Date.now()) {
  const toolCall = payload.toolCall
  const tool = toolCall?.name ? String(toolCall.name) : ''
  const command = toolCall ? summarizeAntigravityInput(toolCall.name, toolCall.args) : ''
  const cwd = typeof payload.cwd === 'string'
    ? payload.cwd
    : (Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] || '' : '')
  return {
    sessionId: payload.conversationId,
    runtime: 'antigravity',
    kind: 'permission',
    at: now,
    cwd,
    message: reason,
    tool: tool.slice(0, 100),
    command: command.slice(0, 2000),
    transcriptPath: typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '',
  }
}

const ROLE_TAG_RE =
  /(?:^|\n)\s*(?:@[A-Za-z0-9_.-]+\s+)*\[zarvis:\s*role=(interface|manager|worker)(?:\s+parent=([A-Za-z0-9_-]{8,80}))?\s*\]/i
const SWARM_ASSIGNMENT_RE =
  /\bsender=([A-Za-z0-9_-]{8,80})\b[\s\S]*?You have just started\.\s*Your assignment \(recorded on the board as #\d+ for @([A-Za-z0-9_.-]+)\):/i
const SUBAGENT_MESSAGE_RE =
  /\[Message\][^\n]*\bsender=([A-Za-z0-9_-]{8,80})\b[^\n]*\scontent=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i
const HEAD_BYTES = 32 * 1024

/** Check role tag or native swarm/subagent worker assignment in prompt/message text. */
export function buildAntigravityRoleTag(payload, now = Date.now()) {
  let prompt = typeof payload.lastUserInput === 'string' ? payload.lastUserInput : ''
  prompt = prompt
    .replace(/^\s*<USER_REQUEST>\s*/i, '')
    .replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+/, '')
  const id = payload.conversationId || payload.session_id
  const m = ROLE_TAG_RE.exec(prompt)
  if (m) return { sessionId: id, role: m[1].toLowerCase(), parent: m[2] || '', at: now }
  const sw = SWARM_ASSIGNMENT_RE.exec(prompt)
  if (sw) return { sessionId: id, role: 'worker', parent: sw[1], at: now }
  if (prompt.includes('[swarm] new board message')) return null
  const sub = SUBAGENT_MESSAGE_RE.exec(prompt)
  if (sub) return { sessionId: id, role: 'worker', parent: sub[1], at: now }
  return null
}

async function readHead(file, maxBytes = HEAD_BYTES) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Fallback: inspect the first 32 KB of transcriptPath for role tag or swarm worker assignment in initial steps. */
export async function detectRoleTagFromTranscript(transcriptPath, id, now = Date.now()) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  let head
  try {
    head = await readHead(transcriptPath)
  } catch {
    return null
  }
  let seenUserInput = false
  for (const line of head.split('\n')) {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (!r || typeof r !== 'object' || typeof r.content !== 'string') continue
    const isUser = r.type === 'USER_INPUT' || r.source === 'USER_EXPLICIT'
    const isSystem = r.type === 'SYSTEM_MESSAGE' || r.source === 'SYSTEM'
    if (isUser) {
      if (seenUserInput) break
      seenUserInput = true
      const tag = buildAntigravityRoleTag({ conversationId: id, lastUserInput: r.content }, now)
      if (tag) return tag
    } else if (isSystem && !seenUserInput) {
      const tag = buildAntigravityRoleTag({ conversationId: id, lastUserInput: r.content }, now)
      if (tag) return tag
    }
  }
  return null
}

async function ensureRoleTag(payload, id, rolesDir) {
  const roleFile = path.join(rolesDir, `${id}.json`)
  try {
    await fsp.access(roleFile)
    return
  } catch {
    /* not tagged yet */
  }

  await fsp.mkdir(rolesDir, { recursive: true })
  let first = false
  try {
    await fsp.writeFile(path.join(rolesDir, `${id}.first`), '', { flag: 'wx' })
    first = true
  } catch {
    /* subsequent prompt or tool call */
  }

  let tag = first ? buildAntigravityRoleTag(payload) : null
  if (!tag && payload.transcriptPath) {
    tag = await detectRoleTagFromTranscript(payload.transcriptPath, id)
  }
  if (tag) {
    try {
      await fsp.writeFile(roleFile, JSON.stringify(tag), { flag: 'wx' })
    } catch {
      /* already tagged */
    }
  }
}

async function writeAtomic(file, marker) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(marker))
  await fsp.rename(tmp, file)
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** Checkout claims guard for Antigravity run_command tool calls. */
async function guardToolCall(payload, home = getHome()) {
  const toolCall = payload.toolCall
  if (toolCall?.name !== 'run_command' || !toolCall.args) return null
  const command = toolCall.args.CommandLine ?? toolCall.args.command
  if (typeof command !== 'string') return null

  try {
    const claims = await import('../lib/claims.mjs')
    const ctx = {
      home,
      now: Date.now(),
      deps: claims.realDeps,
      self: () => claims.sessionProcess({}),
      name: (sid) => claims.sessionName(sid),
    }
    const claudePayload = {
      session_id: payload.conversationId,
      cwd: payload.cwd || (Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] || '' : ''),
      tool_name: 'Bash',
      tool_input: { command },
    }
    return claims.guard(claudePayload, ctx)
  } catch {
    return null
  }
}

/** Auto-events logger for git push / gh pr create in run_command. */
async function autoEventsAntigravity(payload, home = getHome()) {
  const toolCall = payload.toolCall
  if (toolCall?.name !== 'run_command' || !toolCall.args) return
  const command = toolCall.args.CommandLine ?? toolCall.args.command
  if (typeof command !== 'string' || !/\bpush\b|\bpr\b/.test(command)) return
  try {
    const events = await import('../lib/events.mjs')
    await events.logAutoEvents({
      session_id: payload.conversationId,
      tool_name: 'Bash',
      tool_input: { command },
    }, home)
  } catch {
    /* non-blocking */
  }
}

export async function handleHook(mode, payload) {
  const id = payload?.conversationId || payload?.session_id
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return { decision: "allow" }

  const home = getHome()
  const dir = path.join(home, 'blocked')
  const workingDir = path.join(home, 'working')
  const rolesDir = path.join(home, 'roles')

  const file = path.join(dir, `${id}.json`)
  const workFile = path.join(workingDir, `${id}.json`)

  if (mode === 'session_start') {
    // Initial session life: write an idle marker until first prompt
    await writeAtomic(workFile, buildAntigravityWorking(payload, null, Date.now(), 'idle'))
    return { decision: "allow" }
  }

  if (mode === 'pre_invocation') {
    // Turn started: session is working, clear previous blocked markers
    await fsp.rm(file, { force: true })
    let prev = await readJson(workFile)

    // First prompt / swarm worker assignment role registration
    await ensureRoleTag(payload, id, rolesDir)

    await writeAtomic(workFile, buildAntigravityWorking(payload, prev, Date.now(), 'working'))
    return {}
  }

  if (mode === 'pre_tool_use') {
    let prev = await readJson(workFile)
    await writeAtomic(workFile, buildAntigravityWorking(payload, prev, Date.now(), 'working'))

    // Fallback role registration if transcript only flushed by first tool call
    await ensureRoleTag(payload, id, rolesDir)

    // Auto-promote untagged coordinator session to manager when spawning workers
    const tc = payload.toolCall
    const isSwarmAdd = tc?.name === 'swarm' && tc.args?.action === 'add'
    const isWorkerSubagent = tc?.name === 'invoke_subagent' && /\[zarvis:\s*role=worker\b/i.test(String(tc.args?.Prompt || ''))
    if (isSwarmAdd || isWorkerSubagent) {
      await fsp.mkdir(rolesDir, { recursive: true })
      try {
        await fsp.writeFile(
          path.join(rolesDir, `${id}.json`),
          JSON.stringify({ sessionId: id, role: 'manager', parent: '', at: Date.now() }),
          { flag: 'wx' },
        )
      } catch {
        /* already tagged */
      }
    }

    // Claims guard check
    const askGuard = await guardToolCall(payload, home)
    if (askGuard && typeof askGuard === 'object') {
      const reason = askGuard.reason || 'Checkout claimed by another session'
      await writeAtomic(file, buildAntigravityBlockedMarker(payload, reason))
      return { decision: 'ask', reason }
    }

    return { decision: 'allow' }
  }

  if (mode === 'post_tool_use') {
    let prev = await readJson(workFile)
    await writeAtomic(workFile, buildAntigravityWorking(payload, prev, Date.now(), 'working'))
    await ensureRoleTag(payload, id, rolesDir)
    await autoEventsAntigravity(payload, home)
    return {}
  }

  if (mode === 'stop') {
    await ensureRoleTag(payload, id, rolesDir)
    let q = null
    if (typeof payload.transcriptPath === 'string') {
      try {
        q = askedQuestionAntigravity(await readTail(payload.transcriptPath))
      } catch {
        /* transcript unreadable */
      }
    }

    if (q) {
      await writeAtomic(file, buildAntigravityQuestionMarker(payload, q))
    } else {
      await fsp.rm(file, { force: true })
    }

    await writeAtomic(workFile, buildAntigravityWorking(payload, null, Date.now(), 'idle'))
    return { decision: "allow" }
  }

  return { decision: "allow" }
}

async function main() {
  const mode = process.argv[2] || 'pre_invocation'
  let guardTimer = setTimeout(() => {
    process.stdout.write('{}\n')
    process.exit(0)
  }, GUARD_TIMEOUT_MS)

  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  clearTimeout(guardTimer)

  let payload = {}
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    process.stdout.write('{}\n')
    return
  }

  try {
    const result = await handleHook(mode, payload)
    process.stdout.write(`${JSON.stringify(result || {})}\n`)
  } catch {
    process.stdout.write('{}\n')
  }
}

// Only run when executed directly
if (process.argv[1]?.endsWith('zarvis-antigravity-hook.mjs')) {
  main().catch(() => {
    process.stdout.write('{}\n')
  })
}
