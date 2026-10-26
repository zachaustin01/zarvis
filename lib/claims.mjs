// Checkout claims: which session is working in which git checkout (worktree root), so two sessions
// don't edit the same files unknowingly. State lives in ~/.zarvis/claims/<id>.json (ZARVIS_HOME aware),
// id = first 16 hex of sha1(realpath of the checkout root). Shared by the hook (guard / guardpost /
// SessionEnd), the claims CLI, the server and the roster.
//
// The hook side is on the hot path of every tool call, so everything here is synchronous fs reads on
// small files and no process spawns. The exceptions are `ps -o lstart=` (the process start time that
// tells a reused pid from the real one) and the ancestor walk, which run only when a claim is created
// or taken over, or when another session's claim is being judged (the conflict path), never otherwise.
//
// Zarvis only ever ASKS: a conflicting tool call gets permissionDecision "ask" naming the holder, and
// the user decides. Nothing here denies, and every failure is the caller's to swallow.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DESKTOP_SESSIONS } from './sessions.mjs'

export const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/
export const STALE_MS = 8 * 3600 * 1000 // nobody wrote there for this long: anyone may take it over
export const REFRESH_MS = 60 * 1000 // the holder's lastWrite is rewritten at most this often
const MAX_PENDING = 20
const MAX_SHARED = 20
const MAX_CLAIMS = 200 // readers look at no more files than this

export const zarvisHome = (env = process.env) => env.ZARVIS_HOME || path.join(os.homedir(), '.zarvis')
export const claimsDir = (home = zarvisHome()) => path.join(home, 'claims')
export const claimId = (root) => crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)

const str = (v, max = 300) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, max) : '')
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)

// --- checkout, branch, label ---

/** The checkout root holding `from` (a file or directory, which need not exist): the nearest ancestor with a `.git` (a file means a linked worktree). */
export function findRoot(from) {
  let p = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(p, '.git'))) {
      try {
        return fs.realpathSync(p)
      } catch {
        return p
      }
    }
    const up = path.dirname(p)
    if (up === p) return null
    p = up
  }
}

/** Branch name from `.git/HEAD` (following a linked worktree's `gitdir:` file); `detached@<sha7>` when detached. No git spawn. */
export function readBranch(root) {
  try {
    let gitDir = path.join(root, '.git')
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))
      if (!m) return ''
      gitDir = path.resolve(root, m[1].trim())
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (ref) return ref[1]
    return /^[0-9a-f]{7,}$/i.test(head) ? `detached@${head.slice(0, 7).toLowerCase()}` : ''
  } catch {
    return ''
  }
}

export const JIRA = /[A-Z][A-Z0-9]+-\d+/i
export const jiraKey = (text) => JIRA.exec(String(text ?? ''))?.[0].toUpperCase() || ''

/** A Jira key in the branch name, else the branch itself. A manual label (from `claim <KEY>`) overrides both. */
export function labelFor(branch, manual = '') {
  if (manual) return { label: manual, labelKind: 'manual' }
  const key = jiraKey(branch)
  if (key) return { label: key, labelKind: 'jira' }
  return { label: branch || '(no branch)', labelKind: 'branch' }
}

/** What `claim <KEY>` stores: a Jira-shaped key is upper-cased, anything else short and plain is kept. */
export function cleanKey(key) {
  const k = String(key ?? '').trim()
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(k)) return k.toUpperCase()
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/.test(k)) return k
  throw Object.assign(new Error('claim label must be a Jira key (PROJ-123) or a short plain word'), { refusal: true })
}

// --- the claim file ---

/** Validate one parsed claim. Returns a clean object (sizes capped) or null. */
export function parseClaim(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return null
  const root = str(raw.root, 1000)
  const h = raw.holder
  if (!root || !path.isAbsolute(root) || !h || typeof h !== 'object' || !SAFE_ID.test(h.sessionId || '')) return null
  const shared = (Array.isArray(raw.shared) ? raw.shared : [])
    .filter((s) => s && SAFE_ID.test(s.sessionId || ''))
    .slice(0, MAX_SHARED)
    .map((s) => ({ sessionId: s.sessionId, name: str(s.name, 120), since: num(s.since) }))
  const pending = {}
  if (raw.pending && typeof raw.pending === 'object') {
    for (const [k, v] of Object.entries(raw.pending).slice(-MAX_PENDING)) if (SAFE_ID.test(k) && typeof v === 'string') pending[k] = v.slice(0, 200)
  }
  return {
    v: 1,
    root,
    label: str(raw.label, 120),
    labelKind: ['jira', 'branch', 'manual'].includes(raw.labelKind) ? raw.labelKind : 'branch',
    branch: str(raw.branch, 200),
    holder: { sessionId: h.sessionId, pid: Math.trunc(num(h.pid)), pidStart: str(h.pidStart, 100), name: str(h.name, 120), since: num(h.since), lastWrite: num(h.lastWrite) || num(h.since) },
    shared,
    pending,
  }
}

/** One claim file: null when absent, throws when it is not a valid claim (the hook then does nothing at all). */
export function readClaim(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  const claim = parseClaim(JSON.parse(text))
  if (!claim) throw new Error(`${file} is not a valid claim`)
  return claim
}

/** Every valid claim in the directory, with its file; junk, unreadable files and names that don't match their root are skipped. */
export function readClaims(home = zarvisHome()) {
  let names = []
  try {
    names = fs.readdirSync(claimsDir(home))
  } catch {
    return []
  }
  const out = []
  for (const n of names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).slice(0, MAX_CLAIMS)) {
    try {
      const file = path.join(claimsDir(home), n)
      const claim = readClaim(file)
      if (claim && claimId(claim.root) === n.slice(0, -5)) out.push({ file, id: n.slice(0, -5), claim })
    } catch {
      /* mid-write or junk */
    }
  }
  return out
}

/** temp file + rename, so a reader sees the old claim or the new one, never half of one. */
export function writeClaim(file, claim) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(claim))
  fs.renameSync(tmp, file)
}

/** Create a claim only if there is none (exclusive create): of two sessions racing, exactly one gets true. */
export function createClaim(file, claim) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, JSON.stringify(claim), { flag: 'wx' })
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
}

/** Replace `seen` by `next` only if the file still holds the same holder (re-read right before the rename). */
function takeOver(file, seen, next) {
  const now = readClaim(file)
  if (!now || now.holder.sessionId !== seen.holder.sessionId || now.holder.since !== seen.holder.since) return false
  writeClaim(file, next)
  return true
}

// --- processes ---

/** `ps -o lstart=` for a pid: the process start time as text, or null. One spawn; see the header for when. */
export function psLstart(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 250, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function psParent(pid) {
  try {
    const m = /^\s*(\d+)\s+(.*)$/.exec(execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 250, stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    return m ? { ppid: Number(m[1]), comm: m[2] } : null
  } catch {
    return null
  }
}

/** The nearest ancestor of `pid` (itself included) that looks like the `claude` process, or 0. */
export function findClaudeAncestor(pid, parentOf = psParent) {
  for (let hop = 0, p = pid; hop < 8 && p > 1; hop++) {
    const info = parentOf(p)
    if (!info) return 0
    if (/(^|\/)claude/i.test(info.comm)) return p
    p = info.ppid
  }
  return 0
}

/**
 * The long-lived `claude` process of the calling session. A hook's parent IS that process; a CLI run
 * from the Bash tool is deeper, so it trusts CLAUDE_PID and otherwise walks up. 0 = unknown (the
 * claim then expires only by staleness or release).
 */
export function sessionProcess({ env = process.env, ppid = process.ppid, pid = process.pid, from = 'hook', parentOf = psParent, lstart = psLstart } = {}) {
  const envPid = Number(env.CLAUDE_PID)
  const hasEnv = Number.isInteger(envPid) && envPid > 1
  let found = 0
  if (from === 'hook') found = !hasEnv || envPid === ppid ? ppid : findClaudeAncestor(ppid, parentOf) || ppid
  else found = hasEnv ? envPid : findClaudeAncestor(pid, parentOf)
  return { pid: found > 1 ? found : 0, pidStart: found > 1 ? lstart(found) || '' : '' }
}

/** Real liveness probes. Tests pass their own. */
export const realDeps = {
  kill(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return e.code === 'EPERM'
    }
  },
  lstart: psLstart,
}

/**
 * Is the holder still there? Dead when nobody wrote for 8h, its pid is gone, or (with `verifyStart`, the
 * one place a `ps` is spawned) the pid now belongs to a process that started at another time. A holder with
 * no known pid is live until it goes stale.
 */
export function holderLive(claim, now, deps = realDeps, { verifyStart = true } = {}) {
  const h = claim.holder
  if (now - h.lastWrite > STALE_MS) return false
  if (!h.pid) return true
  if (!deps.kill(h.pid)) return false
  if (verifyStart && h.pidStart) {
    const started = deps.lstart(h.pid)
    if (started && started !== h.pidStart) return false
  }
  return true
}

// --- what a Bash command does to a checkout (best effort) ---

/** Words of each simple command in a shell line. Quotes and backslashes respected; `&& || ; | & ( ) $( ` and newlines end a command. */
export function shellSegments(command) {
  const segs = []
  let words = []
  let cur = ''
  let has = false
  let q = ''
  const endWord = () => {
    if (has) words.push(cur)
    cur = ''
    has = false
  }
  const endSeg = () => {
    endWord()
    if (words.length) segs.push(words)
    words = []
  }
  const s = String(command ?? '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) q = ''
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      q = c
      has = true
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i]
      has = true
    } else if (/\s/.test(c) && c !== '\n') endWord()
    else if (c === '$' && s[i + 1] === '(') {
      endSeg()
      i++
    } else if ('\n;|&()`{}'.includes(c)) endSeg()
    else {
      cur += c
      has = true
    }
  }
  endSeg()
  return segs
}

const SKIP_WORDS = new Set(['env', 'command', 'time', 'sudo', 'nice', 'exec', 'then', 'do', 'else', 'if', 'while', 'until', '!', 'builtin'])
const OPT_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

/** Every `git` invocation in a command: [{ dir, sub, args }], dir being the directory it runs in (cwd plus any `-C`). */
export function gitInvocations(command, cwd) {
  const out = []
  for (const words of shellSegments(command)) {
    let i = 0
    while (i < words.length && (SKIP_WORDS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++
    if (path.basename(words[i] ?? '') !== 'git') continue
    let dir = cwd
    for (i++; i < words.length; i++) {
      const w = words[i]
      if (w === '-C' && i + 1 < words.length) dir = path.resolve(dir, words[++i])
      else if (OPT_WITH_VALUE.has(w)) i++
      else if (!w.startsWith('-')) break
    }
    if (i < words.length) out.push({ dir, sub: words[i], args: words.slice(i + 1) })
  }
  return out
}

const WHOLE_ALWAYS = new Set(['stash', 'checkout', 'switch', 'reset', 'clean', 'rebase', 'merge', 'cherry-pick', 'pull'])
const WITH_VALUE = new Set(['-m', '-F', '-C', '-c', '-S', '--message', '--file', '--author', '--date', '--reuse-message'])

/** Whole-tree git: can sweep another session's uncommitted changes (add -A/./-u, commit -a, stash, checkout, reset, ...). */
export function isWholeTree(sub, args) {
  if (WHOLE_ALWAYS.has(sub)) return true
  const flags = []
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') rest.push(...args.slice(i + 1))
    else if (WITH_VALUE.has(a)) i++
    else if (a.startsWith('--')) flags.push(a)
    else if (/^-[A-Za-z]+$/.test(a)) flags.push(...[...a.slice(1)].map((f) => `-${f}`))
    else rest.push(a)
  }
  const dot = rest.some((a) => a === '.' || a === ':/' || a === '*')
  if (sub === 'add') return dot || flags.some((f) => ['-A', '-u', '--all', '--update'].includes(f))
  if (sub === 'commit') return flags.some((f) => f === '-a' || f === '--all')
  if (sub === 'restore') return dot
  return false
}

const WRITE_TOOLS = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/** The checkouts a tool call touches: [{ root, whole, sub }]. Only write tools and `git` commands count; other shell writes (sed -i, redirects) are not seen. */
export function touchedRoots(payload) {
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd()
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const roots = new Map()
  const add = (from, whole, sub) => {
    const root = findRoot(from)
    if (!root) return
    const prev = roots.get(root)
    if (!prev || (whole && !prev.whole)) roots.set(root, { root, whole, sub: whole ? sub : prev?.sub || sub })
  }
  const tool = payload.tool_name
  if (WRITE_TOOLS[tool]) {
    const f = input[WRITE_TOOLS[tool]]
    if (typeof f === 'string' && f) add(path.dirname(path.resolve(cwd, f)), false, '')
  } else if (tool === 'Bash' && typeof input.command === 'string' && /\bgit\b/.test(input.command)) {
    for (const g of gitInvocations(input.command, cwd)) add(g.dir, isWholeTree(g.sub, g.args), g.sub)
  }
  return [...roots.values()]
}

// --- the decision ---

const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
const tilde = (p) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p)
export const shortPath = tilde

/** The desktop app's title for a session (cheap: two readdirs and one file), else a short id. Used only when a claim is written. */
export function sessionName(sessionId, hostId = process.env.CLAUDE_CODE_HOST_SESSION_ID) {
  try {
    if (/^local_[0-9a-f-]{36}$/i.test(hostId || '')) {
      for (const a of fs.readdirSync(DESKTOP_SESSIONS)) {
        for (const o of fs.readdirSync(path.join(DESKTOP_SESSIONS, a))) {
          const f = path.join(DESKTOP_SESSIONS, a, o, `${hostId}.json`)
          if (fs.existsSync(f)) {
            const title = str(JSON.parse(fs.readFileSync(f, 'utf8')).title, 120).trim()
            if (title) return title
          }
        }
      }
    }
  } catch {
    /* no desktop records: fall through */
  }
  return `session ${sessionId.slice(0, 8)}`
}

const askOutput = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })

function describe(claim, now) {
  const where = [claim.label, claim.branch && claim.branch !== claim.label ? `branch ${claim.branch}` : ''].filter(Boolean).join(', ')
  return `“${claim.holder.name || claim.holder.sessionId.slice(0, 8)}” (${where}; last write ${ago(now - claim.holder.lastWrite)})`
}

function freshClaim(root, ctx, sid, manual = '') {
  const now = ctx.now
  const branch = readBranch(root)
  const me = ctx.self()
  return {
    v: 1,
    root,
    ...labelFor(branch, manual),
    branch,
    holder: { sessionId: sid, pid: me.pid, pidStart: me.pidStart, name: ctx.name(sid), since: now, lastWrite: now },
    shared: [],
    pending: {},
  }
}

/**
 * Judge one touched checkout for session `sid`. Returns an ask reason string, or null for "no decision".
 * Claims it if free or abandoned; refreshes the holder's lastWrite; records a pending allow when it asks.
 */
function judge(file, root, sid, toolUseId, whole, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = readClaim(file)
    if (!claim) {
      if (createClaim(file, freshClaim(root, ctx, sid))) return null
      continue // lost the race: judge the winner's claim
    }
    const h = claim.holder
    const sharing = claim.shared.some((s) => s.sessionId === sid)
    if (h.sessionId === sid) {
      const branch = readBranch(claim.root)
      const moved = branch && branch !== claim.branch
      if (moved || ctx.now - h.lastWrite >= REFRESH_MS) {
        const next = { ...claim, holder: { ...h, lastWrite: ctx.now }, ...(moved ? { branch, ...labelFor(branch, claim.labelKind === 'manual' ? claim.label : '') } : {}) }
        try {
          writeClaim(file, next)
        } catch {
          /* a refresh that fails changes nothing about the decision */
        }
      }
      return whole && claim.shared.length ? wholeReason(claim, `sharing with ${claim.shared.map((s) => s.name || s.sessionId.slice(0, 8)).join(', ')}`) : null
    }
    // Someone else holds it. A sharer only checks cheaply (no ps); anyone else is the conflict path.
    if (!holderLive(claim, ctx.now, ctx.deps, { verifyStart: !sharing })) {
      if (takeOver(file, claim, freshClaim(root, ctx, sid))) return null
      continue
    }
    if (sharing) return whole ? wholeReason(claim, `held by ${describe(claim, ctx.now)}`) : null
    if (toolUseId) {
      try {
        const pending = Object.entries({ ...claim.pending, [sid]: toolUseId }).slice(-MAX_PENDING)
        writeClaim(file, { ...claim, pending: Object.fromEntries(pending) })
      } catch {
        /* the ask still goes out; Allow just won't be remembered */
      }
    }
    return `Zarvis: ${tilde(claim.root)} is claimed by ${describe(claim, ctx.now)}. Allow = share this checkout (while shared, whole-tree git such as add -A, commit -a, stash, checkout or reset asks every time).`
  }
  return null
}

const wholeReason = (claim, who) => `Zarvis: ${tilde(claim.root)} (${claim.label}) is shared — ${who}. This is whole-tree git, which can sweep up the other session's uncommitted changes; confirm each time.`

/**
 * PreToolUse: the output to print (an `ask` decision) or null for "no decision". Throws on a corrupt
 * claim file or other internal error; the hook catches that and prints nothing.
 * ctx: { home, now, deps: { kill, lstart }, self(): { pid, pidStart }, name(sessionId): string }
 */
export function guard(payload, ctx) {
  const sid = payload.session_id // a subagent's call carries its parent's session_id, so it never conflicts with it
  if (!SAFE_ID.test(sid || '')) return null
  const reasons = []
  for (const t of touchedRoots(payload)) {
    const r = judge(path.join(claimsDir(ctx.home), `${claimId(t.root)}.json`), t.root, sid, payload.tool_use_id, t.whole, ctx)
    if (r) reasons.push(r)
  }
  return reasons.length ? askOutput(reasons.join('\n')) : null
}

/** PostToolUse: if the user allowed this very tool call (same tool_use_id as the pending ask), join the claim's sharers. */
export function guardPost(payload, ctx) {
  const sid = payload.session_id
  if (!SAFE_ID.test(sid || '') || typeof payload.tool_use_id !== 'string') return
  for (const t of touchedRoots(payload)) {
    const file = path.join(claimsDir(ctx.home), `${claimId(t.root)}.json`)
    const claim = readClaim(file)
    if (!claim || claim.pending[sid] !== payload.tool_use_id) continue
    const { [sid]: _gone, ...pending } = claim.pending
    const shared = claim.shared.some((s) => s.sessionId === sid) || claim.holder.sessionId === sid ? claim.shared : [...claim.shared, { sessionId: sid, name: ctx.name(sid), since: ctx.now }].slice(-MAX_SHARED)
    writeClaim(file, { ...claim, shared, pending })
  }
}

/** SessionEnd: release every claim the session holds and leave every claim it shares. Returns the released roots. */
export function releaseSession(home, sessionId, onlyRoot = '') {
  const released = []
  if (!SAFE_ID.test(sessionId || '')) return released
  for (const { file, claim } of readClaims(home)) {
    if (onlyRoot && claim.root !== onlyRoot) continue
    if (claim.holder.sessionId === sessionId) {
      fs.rmSync(file, { force: true })
      released.push(claim.root)
    } else if (claim.shared.some((s) => s.sessionId === sessionId) || sessionId in claim.pending) {
      const { [sessionId]: _gone, ...pending } = claim.pending
      writeClaim(file, { ...claim, shared: claim.shared.filter((s) => s.sessionId !== sessionId), pending })
      released.push(claim.root)
    }
  }
  return released
}

/**
 * `claim <KEY>`: the session takes (or relabels) the checkout under a manual label. Throws a refusal when
 * another live session holds it, or this session only shares it.
 */
export function claimManual(root, key, sid, ctx) {
  const file = path.join(claimsDir(ctx.home), `${claimId(root)}.json`)
  const label = cleanKey(key)
  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = readClaim(file)
    const fresh = () => freshClaim(root, ctx, sid, label)
    if (!claim) {
      if (createClaim(file, fresh())) return { action: 'claimed', root, label }
      continue
    }
    if (claim.holder.sessionId === sid) {
      writeClaim(file, { ...claim, label, labelKind: 'manual', holder: { ...claim.holder, lastWrite: ctx.now } })
      return { action: 'relabelled', root, label }
    }
    if (!holderLive(claim, ctx.now, ctx.deps)) {
      if (takeOver(file, claim, fresh())) return { action: 'took over', root, label }
      continue
    }
    throw Object.assign(new Error(`${shortPath(root)} is claimed by ${describe(claim, ctx.now)}; it is theirs until released or abandoned`), { refusal: true })
  }
  throw Object.assign(new Error(`${shortPath(root)} changed while claiming it; try again`), { refusal: true })
}

/** A claim as the readers (server, roster, CLI) show it. `names` maps sessionId to a current display name. */
export function claimView({ id, claim }, now, deps = realDeps, names = {}) {
  const nm = (s) => names[s.sessionId] || s.name || s.sessionId.slice(0, 8)
  const stale = now - claim.holder.lastWrite > STALE_MS
  return {
    id,
    root: claim.root,
    label: claim.label,
    labelKind: claim.labelKind,
    branch: claim.branch,
    holder: { sessionId: claim.holder.sessionId, name: nm(claim.holder), since: claim.holder.since, lastWrite: claim.holder.lastWrite },
    shared: claim.shared.map((s) => ({ sessionId: s.sessionId, name: nm(s), since: s.since })),
    live: holderLive(claim, now, deps),
    stale,
  }
}
