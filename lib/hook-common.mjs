/**
 * Shared fail-safe utilities for Zarvis lifecycle hooks (Claude Code and Antigravity).
 * Must never throw unexpectedly or write to stdout/stderr on its own.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/
export const TAIL_BYTES = 256 * 1024
export const HEAD_BYTES = 32 * 1024
export const GUARD_TIMEOUT_MS = 400

/** Resolve ZARVIS_HOME dynamically so in-process tests can override it. */
export function getHome() {
  return process.env.ZARVIS_HOME || path.join(os.homedir(), '.zarvis')
}

/** Validate a session or agent ID before using it in file paths. */
export function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id)
}

/** Read up to `maxBytes` from the tail of a file as UTF-8. */
export async function readTail(file, maxBytes = TAIL_BYTES) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Read up to `maxBytes` from the head of a file as UTF-8. */
export async function readHead(file, maxBytes = HEAD_BYTES) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Read and parse a JSON marker file, returning null on missing or malformed input. */
export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** Atomically write a JSON marker file via a PID-scoped temp file and rename. */
export async function writeAtomic(file, marker) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(marker))
  await fsp.rename(tmp, file)
}

/** Remove a marker file if present; never throws if missing. */
export async function clearMarker(file) {
  await fsp.rm(file, { force: true })
}

/** Read and parse JSON from stdin (or a stream), returning null on invalid JSON. */
export async function readStdinJson(stream = process.stdin) {
  const chunks = []
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

const ROLE_TAG_START_RE =
  /^\s*\[zarvis:\s*role=(interface|manager|worker)(?:\s+parent=([A-Za-z0-9_-]{8,80}))?\s*\]/i
const ROLE_TAG_MULTILINE_RE =
  /(?:^|\n)\s*(?:@[A-Za-z0-9_.-]+\s+)*\[zarvis:\s*role=(interface|manager|worker)(?:\s+parent=([A-Za-z0-9_-]{8,80}))?\s*\]/i

/** Strip leading `<system-reminder>` blocks injected before the user's text. */
export function stripLeadingSystemReminders(text) {
  return typeof text === 'string' ? text.replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+/, '') : ''
}

/**
 * Parse a `[zarvis: role=...]` tag from prompt text.
 * By default only matches at the very start of the text; `multiline: true` also allows
 * line-start tags and leading `@mention` prefixes (used by Antigravity swarm/board prompts).
 */
export function parseRoleTag(text, sessionId, now = Date.now(), { multiline = false } = {}) {
  const re = multiline ? ROLE_TAG_MULTILINE_RE : ROLE_TAG_START_RE
  const m = re.exec(text)
  return m ? { sessionId, role: m[1].toLowerCase(), parent: m[2] || '', at: now } : null
}

/**
 * Atomically claim the first-prompt sentinel (`<id>.first`) in `rolesDir`.
 * Returns true only for the first caller that creates the sentinel.
 */
export async function claimFirstPrompt(rolesDir, id) {
  await fsp.mkdir(rolesDir, { recursive: true })
  try {
    await fsp.writeFile(path.join(rolesDir, `${id}.first`), '', { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

/** Write `<id>.json` in `rolesDir` with `wx` so the first role tag wins; ignores existing/errors. */
export async function writeRoleTag(rolesDir, id, tag) {
  if (!tag) return
  await fsp.mkdir(rolesDir, { recursive: true })
  try {
    await fsp.writeFile(path.join(rolesDir, `${id}.json`), JSON.stringify(tag), { flag: 'wx' })
  } catch {
    /* already tagged: the first marker wins */
  }
}

/**
 * Emit at most one `warn` ticker event per worker session when its transcript context reaches
 * `workerWarnTokens(home, env)` (default 200k; 0 disables). Fail-silent: never disturbs the session.
 */
export async function checkWorkerContextWarn({
  sessionId,
  transcriptPath,
  home = getHome(),
  env = process.env,
  now = Date.now(),
} = {}) {
  try {
    if (!isSafeId(sessionId) || typeof transcriptPath !== 'string' || !transcriptPath) return false
    const { workerWarnTokens, contextTokens, compactTokens } = await import('./context.mjs')
    const threshold = workerWarnTokens(home, env)
    if (!(threshold > 0)) return false

    const state = await readJson(path.join(home, 'state.json'))
    const stateRole = state?.roles?.[sessionId]?.role
    let role = typeof stateRole === 'string' && stateRole ? stateRole : ''
    if (!role) {
      const tag = await readJson(path.join(home, 'roles', `${sessionId}.json`))
      role = typeof tag?.role === 'string' ? tag.role : ''
    }
    if (role !== 'worker') return false

    const events = await import('./events.mjs')
    if (!events.autoEventsEnabled(home, env)) return false

    const rolesDir = path.join(home, 'roles')
    const sentinel = path.join(rolesDir, `${sessionId}.ctxwarn`)
    try {
      await fsp.access(sentinel)
      return false
    } catch {
      /* not warned yet */
    }

    const tokens = await contextTokens(transcriptPath)
    if (!Number.isFinite(tokens) || tokens < threshold) return false

    await fsp.mkdir(rolesDir, { recursive: true })
    try {
      await fsp.writeFile(sentinel, '', { flag: 'wx' })
    } catch {
      return false
    }

    const text = `context at ${compactTokens(tokens)} tokens (past ${compactTokens(threshold)}) — consider handing off before idle`
    await events.appendEvent(home, events.buildEvent({ kind: 'warn', text, sessionId }, now))
    return true
  } catch {
    return false
  }
}

/** Build the standard context object passed to `lib/claims.mjs` guard functions. */
export function buildClaimsContext(claims, home = getHome()) {
  return {
    home,
    now: Date.now(),
    deps: claims.realDeps,
    self: () => claims.sessionProcess({}),
    name: (sid) => claims.sessionName(sid),
  }
}

/**
 * Append a ticker event for a successful `git push` or `gh pr create` Bash call.
 * Fail-silent: never disturbs the session.
 */
export async function runAutoEvents(payload, home = getHome()) {
  const command = payload?.tool_name === 'Bash' && typeof payload?.tool_input?.command === 'string' ? payload.tool_input.command : ''
  if (!/\bpush\b|\bpr\b/.test(command)) return
  try {
    await (await import('./events.mjs')).logAutoEvents(payload, home)
  } catch {
    /* an event is only a log: never disturb the session */
  }
}

const AUTO_LINK_TOOLS = new Set([
  'SendUserFile',
  'Artifact',
  'Bash',
  'run_command',
  'Write',
  'write_file',
  'edit_file',
])

/**
 * Pin a link chip for SendUserFile, Artifact publish, PR/MR creation, HTML report, or user-facing artifact tool calls.
 * Fail-silent: never disturbs the session.
 */
export async function runAutoLinks(payload, home = getHome()) {
  const name = payload?.tool_name || ''
  if (!AUTO_LINK_TOOLS.has(name)) return
  const input = payload?.tool_input
  if (name === 'Bash' || name === 'run_command') {
    const cmd = input?.command ?? input?.CommandLine
    if (typeof cmd !== 'string' || !/\b(gh|glab)\b|merge_requests/.test(cmd)) return
  } else if (name === 'Write') {
    const f = input?.file_path ?? input?.Path ?? input?.path
    if (typeof f !== 'string' || !/\.html?$/i.test(f)) return
  } else if (name === 'write_file') {
    const f = input?.Path ?? input?.path ?? input?.file_path
    const meta = input?.ArtifactMetadata ?? input?.artifactMetadata
    const userFacing = Boolean(meta && typeof meta === 'object' && (meta.UserFacing === true || meta.userFacing === true))
    if (!userFacing && (typeof f !== 'string' || !/\.html?$/i.test(f))) return
  } else if (name === 'edit_file') {
    const meta = input?.ArtifactMetadata ?? input?.artifactMetadata
    const userFacing = Boolean(meta && typeof meta === 'object' && (meta.UserFacing === true || meta.userFacing === true))
    if (!userFacing) return
  }
  try {
    await (await import('./links.mjs')).logAutoLinks(payload, home)
  } catch {
    /* ignore */
  }
}
