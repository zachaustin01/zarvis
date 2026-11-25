#!/usr/bin/env node
/**
 * Claude Code hook for Zarvis. Not run by the server: point your settings.json at it
 * (see README). `set` marks the session blocked; the other modes track whether it is working.
 *
 *   PermissionRequest                        -> `set`    blocked marker, at once, with tool and input
 *   Notification (matcher permission_prompt) -> `set`    blocked marker (the same prompt, ~6 s later)
 *   UserPromptSubmit                         -> `start`  working marker, clock restarts
 *   PreToolUse / PermissionDenied            -> `resume` blocked marker off, working on
 *   PostToolUse                              -> `work`   working marker refreshed (clock kept); a successful `git push` /
 *                                                       `gh pr create` also appends a ticker event (see autoEvents); SendUserFile / Artifact
 *                                                       publish pin a link chip (see autoLinks)
 *   Stop / SessionStart                      -> `idle`   blocked marker off, working marker says idle; but if the turn
 *                                                       ended on a question for the user (see askedQuestion), a blocked
 *                                                       marker with kind "question" is written instead
 *   SessionEnd                               -> `done`   both markers off (and the background-task and link files)
 *   SubagentStop                             -> `agentstop` blocked marker off if that subagent owned it
 *   PreToolUse (second entry, timeout 5)     -> `guard`  claim the checkout a write / git command touches, or ASK when another live session holds it
 *   PostToolUse (second entry, timeout 5)    -> `guardpost` an allowed ask joins the claim's sharers
 *   (SessionEnd `done` also releases the session's checkout claims; see lib/claims.mjs)
 *
 * Background tasks (lib/tasks.mjs): Stop's `background_tasks` list is written to ~/.zarvis/tasks/<session>.json (a launch
 * seen on PostToolUse is added in between, TaskStop removes); tasks that vanished become a ticker event. No new hook events.
 *
 * Subagents: their tool events and permission prompts carry the PARENT's session_id plus `agent_id`.
 * The parent is the visible session, so a subagent's prompt blocks the parent. But an event from a
 * subagent never clears a marker it did not write (parallel agents, or a main-thread prompt), never
 * writes idle, and a Stop/idle from the parent leaves a subagent's prompt standing (it is still pending).
 *
 * `start` also registers a role when the session's FIRST prompt begins with `[zarvis: role=manager]`
 * (or interface / worker, optionally `parent=<session id>`); the same text elsewhere is ignored.
 *
 * Reads the hook payload (JSON) from stdin. Writes ONLY under ~/.zarvis/blocked/, working/, roles/, tasks/, links/ and claims/ (plus one line in events.jsonl after a push, and a chip in links/ after SendUserFile or an Artifact publish).
 * The transcript is read (never written) to find which tool is waiting, because the
 * Notification payload only carries a sentence like "Claude needs your permission to use Bash".
 * Never throws and never prints: a hook must not disturb the session.
 */
import path from 'node:path'
import {
  GUARD_TIMEOUT_MS,
  getHome,
  isSafeId,
  readTail,
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

/** Build the marker for a Notification payload. Exported for tests. */
export async function buildMarker(payload, now = Date.now()) {
  let tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  let command = ''
  if (payload.tool_input) command = summarizeInput(tool, payload.tool_input)
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id.slice(0, 100) : ''
  if (!command && typeof payload.transcript_path === 'string') {
    try {
      // transcript_path is always the session's; a subagent's own tool calls live beside it.
      const file = agentId && isSafeId(agentId.replace(/^agent-/, '')) ? agentTranscript(payload.transcript_path, agentId) : payload.transcript_path
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

/**
 * The role tag for a UserPromptSubmit payload, or null. Exported for tests. Only a tag at the very
 * start of the user's own text counts (leading whitespace allowed), as `rolePrompt` generates it; a
 * brief or conversation that merely mentions the tag mid-text must not register a role. Leading
 * `<system-reminder>` blocks are skipped first: the desktop app puts one before the user's text in a
 * session started without a project folder. The caller also checks that this is the session's first prompt.
 */
export function buildRoleTag(payload, now = Date.now()) {
  const prompt = stripLeadingSystemReminders(payload.prompt)
  return parseRoleTag(prompt, payload.session_id, now)
}

const WORKER_TAG_RE = /\[zarvis:\s*role=worker\b/i
const CLAUDE_SPAWN_CMD_RE =
  /(?:claude:\/\/code\/new|(?:^|[;&|()\n]\s*)(?:(?:env|nohup|exec|command)\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*|(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)?(?:['"](?:[^'"]*\/)?claude['"]|(?:[^\s;|&()'"]*\/)?claude)(?:\s|$))/

function decodePercent(text) {
  return String(text || '')
    .replace(/\+/g, ' ')
    .replace(/%[0-9A-Fa-f]{2}/g, (m) => {
      try {
        return decodeURIComponent(m)
      } catch {
        return m
      }
    })
}

/**
 * Whether a main-session tool payload spawns a Zarvis worker carrying `[zarvis: role=worker...]`.
 * Used on PreToolUse (`resume`) and PostToolUse (`work`) to auto-promote an untagged session to
 * `manager` (`writeRoleTag` uses `wx`, so an existing role tag is never overwritten).
 */
export function spawnsWorker(payload) {
  if (!payload || typeof payload !== 'object' || payload.agent_id) return false
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const input = payload.tool_input
  if (!tool || !input || typeof input !== 'object') return false
  if (tool === 'Agent' || tool === 'Task') {
    return WORKER_TAG_RE.test(String(input.prompt || '')) || WORKER_TAG_RE.test(String(input.description || ''))
  }
  if (/^(?:mcp__[A-Za-z0-9_-]+__)?(?:start|create|spawn)_session$/i.test(tool)) {
    const text = [input.prompt, input.initial_prompt, input.message, input.description].filter((v) => typeof v === 'string').join('\n')
    return WORKER_TAG_RE.test(text)
  }
  if (tool === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    if (!cmd || !CLAUDE_SPAWN_CMD_RE.test(cmd)) return false
    return WORKER_TAG_RE.test(cmd) || WORKER_TAG_RE.test(decodePercent(cmd))
  }
  return false
}

/**
 * The claim guard: prints at most one `ask` decision, never a deny. Any error or the self-timeout prints
 * nothing and exits 0, which changes nothing about the tool call.
 */
async function guardMode(mode, payload, home) {
  const claims = await import('../lib/claims.mjs')
  const ctx = buildClaimsContext(claims, home)
  if (mode === 'guardpost') return claims.guardPost(payload, ctx)
  const out = claims.guard(payload, ctx)
  if (out) process.stdout.write(JSON.stringify(out))
}

let guardTimer = null

async function main() {
  const mode = process.argv[2]
  const guarding = mode === 'guard' || mode === 'guardpost'
  if (guarding) guardTimer = setTimeout(() => process.exit(0), GUARD_TIMEOUT_MS)
  const payload = await readStdinJson()
  if (!payload) return
  const id = payload?.session_id
  if (!isSafeId(id)) return
  const home = getHome()
  const file = path.join(home, 'blocked', `${id}.json`)
  const workFile = path.join(home, 'working', `${id}.json`)
  const rolesDir = path.join(home, 'roles')
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : ''
  if (guarding) {
    try {
      await guardMode(mode, payload, home)
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
    if (agentId && (await readJson(file))?.agentId === agentId) await clearMarker(file)
  } else if (mode === 'clear') {
    await clearMarker(file)
  } else if (mode === 'done') {
    await Promise.all([clearMarker(file), clearMarker(workFile), clearMarker(path.join(home, 'tasks', `${id}.json`)), clearMarker(path.join(home, 'links', `${id}.json`))])
    try {
      ;(await import('../lib/claims.mjs')).releaseSession(home, id)
    } catch {
      /* the claims are best effort; they also expire */
    }
    try {
      await (await import('../lib/schedule.mjs')).cleanupSessionSchedules(home, id)
    } catch {
      /* schedules cleanup is best effort */
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
      else await clearMarker(file)
    }
    await writeAtomic(workFile, buildWorking(payload, null, Date.now(), 'idle'))
    await backgroundTasks('idle', payload, home)
    if (payload.hook_event_name !== 'SessionStart') await checkWorkerContextWarn({ sessionId: id, transcriptPath: payload.transcript_path, home })
  } else if (mode === 'start' || mode === 'resume' || mode === 'work') {
    const prev = mode !== 'start' ? await readJson(workFile) : null
    if (mode === 'start') {
      // "First prompt" = we are the first `start` to claim the `<id>.first` sentinel (wx write).
      // The working marker can't tell us: SessionStart's idle writes one before any prompt, and
      // idle/work/resume rewrite it. The sentinel is not .json, so the server's role reader skips it.
      const first = await claimFirstPrompt(rolesDir, id)
      const tag = first ? buildRoleTag(payload) : null
      await writeRoleTag(rolesDir, id, tag)
    } else if (!agentId && spawnsWorker(payload)) {
      await writeRoleTag(rolesDir, id, { sessionId: id, role: 'manager', parent: '', at: Date.now() })
    }
    if (mode !== 'work') {
      // Another agent's tool call must not clear a prompt it did not raise; the raising agent's own
      // next event (it got its answer) does, and so does a new prompt.
      const blocked = await readJson(file)
      if (mode === 'start' || !blocked || (blocked.agentId || '') === agentId) await clearMarker(file)
    }
    await writeAtomic(workFile, buildWorking(payload, prev))
    if (mode === 'work') {
      await runAutoEvents(payload, home)
      await runAutoLinks(payload, home)
      await autoSchedulesClaude(payload, home)
      if (!agentId && /^(Bash|Monitor|Agent|Task|TaskStop|KillShell)$/.test(payload.tool_name || '')) await backgroundTasks('work', payload, home)
      if (!agentId) await checkWorkerContextWarn({ sessionId: id, transcriptPath: payload.transcript_path, home })
    }
  }
}

/** Auto-schedules logger for Claude Code `CronCreate` / `CronDelete` calls. Best-effort, never throws. */
export async function autoSchedulesClaude(payload, home = getHome()) {
  try {
    const tool = payload?.tool_name
    if (tool !== 'CronCreate' && tool !== 'CronDelete') return
    const { autoSchedulesEnabled, upsertAutoJob, removeAutoJob } = await import('../lib/schedule.mjs')
    if (!autoSchedulesEnabled(home)) return
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
    if (tool === 'CronCreate') {
      const cron = typeof input.cron === 'string' ? input.cron.trim() : ''
      if (!cron) return
      const resp = payload.tool_response
      const respId = (resp && typeof resp === 'object' && (resp.id || resp.job_id || resp.taskId)) || (typeof resp === 'string' ? (/\bid[:=\s"]+([A-Za-z0-9_-]+)/i.exec(resp)?.[1] || '') : '')
      const externalId = typeof respId === 'string' ? respId.trim() : ''
      const prompt = String(input.prompt || input.name || '').replace(/\s+/g, ' ').trim()
      const name = String(input.name || prompt).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Claude cron'
      const note = prompt.slice(0, 200).trim()
      await upsertAutoJob(home, { name, cron, note, externalId, source: 'claude', owner: { session: payload.session_id, app: '' } })
    } else {
      const externalId = String(input.id || input.job_id || '').trim()
      if (externalId) await removeAutoJob(home, { externalId, source: 'claude' })
    }
  } catch { /* best effort */ }
}

/**
 * Background tasks (lib/tasks.mjs): launches and TaskStop on PostToolUse, the authoritative `background_tasks` list on Stop.
 * Whatever just ended becomes one ticker event. Fail-silent: tasks are decoration, never worth disturbing the session.
 */
async function backgroundTasks(mode, payload, home) {
  try {
    const tasks = await import('../lib/tasks.mjs')
    const finished = await tasks.trackTasks(mode, payload, home)
    const text = tasks.finishedText(finished)
    if (text) {
      const events = await import('../lib/events.mjs')
      if (events.autoEventsEnabled(home)) await events.appendEvent(home, events.buildEvent({ kind: 'done', text, sessionId: payload.session_id }))
    }
  } catch {
    /* ignore */
  }
}

// Only run when executed directly, so tests can import the helpers.
if (process.argv[1]?.endsWith('zarvis-hook.mjs')) {
  main().catch(() => {}).finally(() => clearTimeout(guardTimer))
}
