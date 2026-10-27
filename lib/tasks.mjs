// Background tasks per session: ~/.zarvis/tasks/<sessionId>.json, written only by hooks/zarvis-hook.mjs.
//
// Sources, in order of trust:
//   Stop (`background_tasks`)  the harness's own list of in-flight tasks (shell, subagent, monitor, workflow, ...).
//                              Authoritative: it REPLACES the file, so a missed completion heals at the next Stop.
//                              A finished task wakes the session, so a completion always ends in a Stop.
//   PostToolUse                a launch seen mid-turn (Bash run_in_background, Monitor, Agent/Task run_in_background)
//                              is added; TaskStop / KillShell removes. Entries from here without a real task id in
//                              the payload are `guess` and are matched to the Stop list by kind + label.
//   SessionStart / SessionEnd  clear (a resumed session's old processes are gone).
// A task also expires on its own (`until`, or MAX_TASK_AGE_MS after it started), so nothing pins a card forever.
// Subagent events (payload.agent_id) never touch the file: the Stop list is scoped to the parent session.
import fsp from 'node:fs/promises'
import path from 'node:path'

export const MAX_TASK_AGE_MS = 12 * 60 * 60 * 1000
export const MAX_TASKS = 20
const DONE_STATUS = /^(completed|failed|killed|stopped|cancelled|canceled|error|done)$/i

const clean = (v, max) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

const slug = (v) => clean(v, 20).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'

/** One validated task entry, or null. Shared by the hook (write) and the reader (never trust the file). */
export function parseTask(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = clean(raw.id, 100)
  if (!id) return null
  const startedAt = Number(raw.startedAt)
  const until = Number(raw.until)
  return {
    id,
    kind: slug(raw.kind),
    label: clean(raw.label, 80),
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0,
    until: Number.isFinite(until) && until > 0 ? until : 0,
    guess: raw.guess === true,
  }
}

/** A task entry from one element of the Stop payload's `background_tasks`; null if it is not in flight. */
export function fromStopEntry(e, now) {
  if (!e || typeof e !== 'object' || (typeof e.status === 'string' && DONE_STATUS.test(e.status))) return null
  const label = e.description || e.command || [e.agent_type, e.name, e.tool].filter((x) => typeof x === 'string' && x).join(' ') || ''
  return parseTask({ id: e.id, kind: e.type, label, startedAt: now })
}

/**
 * The task a PostToolUse payload started, or null. Matches the three launch shapes seen in real transcripts:
 * Bash with run_in_background (tool result carries backgroundTaskId), Monitor (taskId), and an async Agent/Task
 * (isAsync + agentId). The id falls back to tool_use_id, which makes the entry a `guess` until the next Stop.
 */
export function launchOf(payload, now = Date.now()) {
  const name = payload?.tool_name
  const input = payload?.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const resp = payload?.tool_response && typeof payload.tool_response === 'object' ? payload.tool_response : {}
  let kind = ''
  let real = ''
  if (name === 'Bash' && input.run_in_background === true) {
    kind = 'shell'
    real = resp.backgroundTaskId
  } else if (name === 'Monitor') {
    kind = 'monitor'
    real = resp.taskId
  } else if ((name === 'Agent' || name === 'Task') && (input.run_in_background === true || resp.isAsync === true || resp.status === 'async_launched')) {
    kind = 'subagent'
    real = resp.agentId
  } else return null
  const id = typeof real === 'string' && real ? real : typeof payload.tool_use_id === 'string' ? payload.tool_use_id : ''
  if (!id) return null
  const timeout = Number(input.timeout_ms)
  return parseTask({
    id,
    kind,
    label: input.description || input.command || input.prompt || '',
    startedAt: now,
    until: kind === 'monitor' && input.persistent !== true && input.persistent !== 'true' && timeout > 0 ? now + timeout : 0,
    guess: !(typeof real === 'string' && real),
  })
}

/** The id TaskStop / KillShell was asked to stop, or ''. */
export function stoppedId(payload) {
  if (payload?.tool_name !== 'TaskStop' && payload?.tool_name !== 'KillShell') return ''
  const i = payload.tool_input
  return clean(i?.task_id ?? i?.shell_id ?? '', 100)
}

/**
 * Which of `prev` are gone from `next`. A `guess` entry matches a `next` entry of the same kind and label
 * (its real id was not in the launch payload), and `next` then keeps the older startedAt.
 * @returns {{ tasks, finished }} `tasks` is `next` with startedAt carried over; `finished` the prev entries that ended
 */
export function reconcile(prev, next) {
  const used = new Set()
  const tasks = next.map((n) => {
    const hit = prev.find((p) => p.id === n.id) || prev.find((p) => p.guess && !used.has(p.id) && p.kind === n.kind && p.label === n.label)
    if (hit) used.add(hit.id)
    return hit ? { ...n, startedAt: hit.startedAt || n.startedAt, until: hit.until || n.until } : n
  })
  return { tasks, finished: prev.filter((p) => !used.has(p.id)) }
}

/** The live tasks of one parsed file at `now`. */
export const liveTasks = (tasks, now = Date.now()) => tasks.filter((t) => (t.until ? now < t.until : !t.startedAt || now - t.startedAt < MAX_TASK_AGE_MS))

/** ticker text for tasks that ended, or '' */
export function finishedText(finished) {
  if (!finished.length) return ''
  const names = finished.map((t) => t.label || t.kind)
  if (finished.length === 1) return `finished a background ${finished[0].kind === 'shell' ? 'command' : finished[0].kind}: ${names[0]}`
  return `finished ${finished.length} background tasks: ${names.slice(0, 2).join(', ')}${finished.length > 2 ? ', …' : ''}`
}

// --- file I/O (hook writes, server reads) ---

export const tasksFile = (home, id) => path.join(home, 'tasks', `${id}.json`)

export async function readTaskFile(file) {
  try {
    const o = JSON.parse(await fsp.readFile(file, 'utf8'))
    return (Array.isArray(o?.tasks) ? o.tasks : []).map(parseTask).filter(Boolean).slice(0, MAX_TASKS)
  } catch {
    return []
  }
}

async function writeTasks(file, sessionId, tasks, now) {
  if (!tasks.length) return fsp.rm(file, { force: true })
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ sessionId, at: now, tasks: tasks.slice(0, MAX_TASKS) }))
  await fsp.rename(tmp, file)
}

/** Every session's live tasks: { sessionId: [task] }. Unreadable files are skipped. */
export async function readAllTasks(home, now = Date.now()) {
  const dir = path.join(home, 'tasks')
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return {}
  }
  const out = {}
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const live = liveTasks(await readTaskFile(path.join(dir, n)), now)
    if (live.length) out[n.slice(0, -5)] = live
  }
  return out
}

/**
 * Hook entry point. `mode` is the hook mode that fired: `work` (PostToolUse), `idle` (Stop / SessionStart) or `done`
 * (SessionEnd). Returns the tasks that finished (for the ticker). Never throws to the caller's concern: the hook wraps it.
 */
export async function trackTasks(mode, payload, home, now = Date.now()) {
  const id = payload?.session_id
  if (typeof payload?.agent_id === 'string' && payload.agent_id) return []
  const file = tasksFile(home, id)
  if (mode === 'done') return fsp.rm(file, { force: true }).then(() => [])
  if (mode === 'idle') {
    if (payload.hook_event_name === 'SessionStart') return fsp.rm(file, { force: true }).then(() => [])
    if (!Array.isArray(payload.background_tasks)) return [] // an older Claude Code: keep what the launches told us
    const prev = liveTasks(await readTaskFile(file), now)
    const { tasks, finished } = reconcile(prev, payload.background_tasks.map((e) => fromStopEntry(e, now)).filter(Boolean))
    await writeTasks(file, id, tasks, now)
    return finished
  }
  if (mode !== 'work') return []
  const stop = stoppedId(payload)
  const launch = stop ? null : launchOf(payload, now)
  if (!stop && !launch) return []
  const prev = liveTasks(await readTaskFile(file), now)
  if (stop) {
    const finished = prev.filter((t) => t.id === stop)
    if (finished.length) await writeTasks(file, id, prev.filter((t) => t.id !== stop), now)
    return finished
  }
  await writeTasks(file, id, [...prev.filter((t) => t.id !== launch.id), launch], now)
  return []
}
