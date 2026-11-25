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
import {
  GUARD_TIMEOUT_MS,
  getHome,
  isSafeId,
  readTail,
  readHead,
  readJson,
  writeAtomic,
  clearMarker,
  readStdinJson,
  stripLeadingSystemReminders,
  parseRoleTag,
  claimFirstPrompt,
  writeRoleTag,
  checkWorkerContextWarn,
  buildClaimsContext,
  runAutoEvents,
  runAutoLinks,
} from '../lib/hook-common.mjs'

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

const SWARM_ASSIGNMENT_RE =
  /\bsender=([A-Za-z0-9_-]{8,80})\b[\s\S]*?You have just started\.\s*Your assignment \(recorded on the board as #\d+ for @([A-Za-z0-9_.-]+)\):/i
const SUBAGENT_MESSAGE_RE =
  /\[Message\][^\n]*\bsender=([A-Za-z0-9_-]{8,80})\b[^\n]*\scontent=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i

/** Check role tag or native swarm/subagent worker assignment in prompt/message text. */
export function buildAntigravityRoleTag(payload, now = Date.now()) {
  const raw = typeof payload.lastUserInput === 'string' ? payload.lastUserInput : ''
  const prompt = stripLeadingSystemReminders(raw.replace(/^\s*<USER_REQUEST>\s*/i, ''))
  const id = payload.conversationId || payload.session_id
  const tag = parseRoleTag(prompt, id, now, { multiline: true })
  if (tag) return tag
  const sw = SWARM_ASSIGNMENT_RE.exec(prompt)
  if (sw) return { sessionId: id, role: 'worker', parent: sw[1], at: now }
  if (prompt.includes('[swarm] new board message')) return null
  const sub = SUBAGENT_MESSAGE_RE.exec(prompt)
  if (sub) return { sessionId: id, role: 'worker', parent: sub[1], at: now }
  return null
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

  const first = await claimFirstPrompt(rolesDir, id)
  let tag = first ? buildAntigravityRoleTag(payload) : null
  if (!tag && payload.transcriptPath) {
    tag = await detectRoleTagFromTranscript(payload.transcriptPath, id)
  }
  await writeRoleTag(rolesDir, id, tag)
}

function resolveAntigravityCwd(payload) {
  if (typeof payload?.cwd === 'string' && payload.cwd) return payload.cwd
  return Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] || '' : ''
}

function buildClaimsPayload(payload) {
  const id = payload?.conversationId || payload?.session_id
  const toolCall = payload?.toolCall
  if (!id || !toolCall?.name || !toolCall.args || typeof toolCall.args !== 'object') return null
  const cwd = resolveAntigravityCwd(payload)
  const explicitUseId = toolCall.id ?? payload.toolUseId ?? payload.tool_use_id
  const toolUseId = typeof explicitUseId === 'string' && explicitUseId
    ? explicitUseId
    : `agy:${toolCall.name}:${summarizeAntigravityInput(toolCall.name, toolCall.args).slice(0, 120)}`
  if (toolCall.name === 'run_command') {
    const command = toolCall.args.CommandLine ?? toolCall.args.command
    if (typeof command !== 'string') return null
    return { session_id: id, cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId }
  }
  if (toolCall.name === 'write_file' || toolCall.name === 'edit_file') {
    const filePath = toolCall.args.Path ?? toolCall.args.path ?? toolCall.args.file_path
    if (typeof filePath !== 'string' || !filePath) return null
    return {
      session_id: id,
      cwd,
      tool_name: toolCall.name,
      tool_input: { ...toolCall.args, file_path: filePath },
      tool_use_id: toolUseId,
    }
  }
  return null
}

/** Checkout claims guard for Antigravity run_command, write_file, and edit_file tool calls. */
async function guardToolCall(payload, home = getHome()) {
  const claudePayload = buildClaimsPayload(payload)
  if (!claudePayload) return null
  try {
    const claims = await import('../lib/claims.mjs')
    const ctx = buildClaimsContext(claims, home)
    return claims.guard(claudePayload, ctx)
  } catch {
    return null
  }
}

/** Checkout claims PostToolUse sharer join when user allowed a pending ask in Antigravity. */
async function guardPostToolCall(payload, home = getHome()) {
  const claudePayload = buildClaimsPayload(payload)
  if (!claudePayload) return
  try {
    const claims = await import('../lib/claims.mjs')
    const ctx = buildClaimsContext(claims, home)
    claims.guardPost(claudePayload, ctx)
  } catch {
    /* a failed guardPost must not disturb the session */
  }
}

async function extractToolResponse(payload) {
  const direct =
    payload?.toolResponse ??
    payload?.toolResult ??
    payload?.tool_response ??
    payload?.output ??
    payload?.result ??
    payload?.response
  if (payload?.error) {
    const errText = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)
    if (typeof direct === 'string') return { isError: true, output: direct, stderr: errText }
    if (direct && typeof direct === 'object') return { ...direct, isError: true, stderr: direct.stderr ?? errText }
    return { isError: true, stderr: errText }
  }
  if (direct !== undefined) return direct
  const tc = payload?.toolCall
  const cmd = tc?.name === 'run_command' ? (tc.args?.CommandLine ?? tc.args?.command) : ''
  if (
    typeof cmd === 'string' &&
    /\b(push|pr|mr)\b|merge_requests/.test(cmd) &&
    typeof payload?.transcriptPath === 'string' &&
    payload.transcriptPath &&
    Number.isInteger(payload.stepIdx)
  ) {
    try {
      const tail = await readTail(payload.transcriptPath, 32 * 1024)
      const lines = tail.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue
        let r
        try {
          r = JSON.parse(lines[i])
        } catch {
          continue
        }
        if (r?.step_index === payload.stepIdx && typeof r.content === 'string') {
          const badCode = /Command exited with code ([1-9]\d*)/.exec(r.content)
          return badCode ? { exitCode: Number(badCode[1]), output: r.content } : r.content
        }
      }
    } catch {
      /* transcript unreadable or not flushed yet */
    }
  }
  return undefined
}

/** Auto-events logger for git push / gh pr create in run_command. */
async function autoEventsAntigravity(payload, home = getHome(), toolResponse = undefined) {
  const id = payload?.conversationId || payload?.session_id
  const toolCall = payload?.toolCall
  if (toolCall?.name !== 'run_command' || !toolCall.args) return
  const command = toolCall.args.CommandLine ?? toolCall.args.command
  if (typeof command !== 'string') return
  await runAutoEvents({
    session_id: id,
    cwd: resolveAntigravityCwd(payload),
    tool_name: 'Bash',
    tool_input: { command },
    ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
  }, home)
}

/** Auto-links logger for PR/MR URLs, HTML reports, and user-facing Antigravity artifacts. */
async function autoLinksAntigravity(payload, home = getHome(), toolResponse = undefined) {
  const id = payload?.conversationId || payload?.session_id
  const toolCall = payload?.toolCall
  if (!toolCall?.name || !toolCall.args || typeof toolCall.args !== 'object') return
  await runAutoLinks({
    session_id: id,
    cwd: resolveAntigravityCwd(payload),
    tool_name: toolCall.name,
    tool_input: toolCall.args,
    ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
  }, home)
}

export async function handleHook(mode, payload) {
  const id = payload?.conversationId || payload?.session_id
  if (!isSafeId(id)) return { decision: "allow" }

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
    await clearMarker(file)
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
      await writeRoleTag(rolesDir, id, { sessionId: id, role: 'manager', parent: '', at: Date.now() })
    }

    // Claims guard check
    const askGuard = await guardToolCall(payload, home)
    if (askGuard && typeof askGuard === 'object') {
      const hso = askGuard.hookSpecificOutput
      const decision = hso?.permissionDecision || askGuard.decision || 'ask'
      const reason = hso?.permissionDecisionReason || askGuard.reason || 'Checkout claimed by another session'
      await writeAtomic(file, buildAntigravityBlockedMarker(payload, reason))
      return { decision, reason }
    }

    await clearMarker(file)
    return { decision: 'allow' }
  }

  if (mode === 'post_tool_use') {
    await clearMarker(file)
    let prev = await readJson(workFile)
    await writeAtomic(workFile, buildAntigravityWorking(payload, prev, Date.now(), 'working'))
    await ensureRoleTag(payload, id, rolesDir)
    await guardPostToolCall(payload, home)
    const toolResponse = await extractToolResponse(payload)
    await autoEventsAntigravity(payload, home, toolResponse)
    await autoLinksAntigravity(payload, home, toolResponse)
    await checkWorkerContextWarn({ sessionId: id, transcriptPath: payload.transcriptPath ?? payload.transcript_path, home })
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
      await clearMarker(file)
    }

    await writeAtomic(workFile, buildAntigravityWorking(payload, null, Date.now(), 'idle'))
    await checkWorkerContextWarn({ sessionId: id, transcriptPath: payload.transcriptPath ?? payload.transcript_path, home })
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

  const payload = await readStdinJson()
  clearTimeout(guardTimer)

  if (!payload) {
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
