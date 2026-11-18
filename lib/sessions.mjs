// Read-only view of the Claude desktop app's session records and CLI transcripts.
import fsp from 'node:fs/promises'
import fs, { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const DESKTOP_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Electron userData of the desktop app; differs per OS (same candidates Bot Crossing uses). */
function desktopDataDir() {
  if (process.platform === 'win32') {
    const roaming = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude')
    return roaming
  }
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude')
  const support = path.join(HOME, 'Library', 'Application Support')
  const candidates = [path.join(support, 'Claude-3p'), path.join(support, 'Claude')]
  return candidates.find((d) => existsSync(path.join(d, 'claude-code-sessions'))) || candidates[1]
}

export const DESKTOP_SESSIONS = process.env.ZARVIS_DESKTOP_SESSIONS || path.join(desktopDataDir(), 'claude-code-sessions')
export const CLI_PROJECTS = process.env.ZARVIS_CLI_PROJECTS || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects')

const dirs = async (d) => {
  try {
    return (await fsp.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name))
  } catch {
    return []
  }
}

/** Desktop records (account/org/local_*.json) plus ids the app has deleted. Cached by mtime. */
const recordCache = new Map()
export async function scanDesktopRecords(root = DESKTOP_SESSIONS) {
  const records = []
  const deleted = new Set()
  for (const account of await dirs(root)) {
    for (const org of await dirs(account)) {
      let names = []
      try {
        names = await fsp.readdir(org)
      } catch {
        continue
      }
      for (const n of names) {
        const del = /^deleted_(.+)$/.exec(n)
        if (del) {
          deleted.add(del[1])
          continue
        }
        if (!n.startsWith('local_') || !n.endsWith('.json')) continue
        const file = path.join(org, n)
        try {
          const st = await fsp.stat(file)
          const hit = recordCache.get(file)
          if (hit && hit.mtime === st.mtimeMs) {
            records.push(hit.rec)
            continue
          }
          const rec = JSON.parse(await fsp.readFile(file, 'utf8'))
          recordCache.set(file, { mtime: st.mtimeMs, rec })
          records.push(rec)
        } catch {
          /* mid-write */
        }
      }
    }
  }
  return { records, deleted }
}

/** Find transcript for a session across Claude and Antigravity locations. */
export async function findTranscript(sessionId, root = CLI_PROJECTS, candidatePath = '') {
  if (!UUID.test(sessionId)) return null
  if (candidatePath) {
    try {
      const st = await fsp.stat(candidatePath)
      return { file: candidatePath, mtime: st.mtimeMs }
    } catch {
      /* candidate not found */
    }
  }
  for (const d of await dirs(root)) {
    const f = path.join(d, `${sessionId}.jsonl`)
    try {
      const st = await fsp.stat(f)
      return { file: f, mtime: st.mtimeMs }
    } catch {
      /* not here */
    }
  }
  const agyCandidates = [
    path.join(HOME, '.gemini', 'antigravity', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(HOME, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(HOME, '.gemini', 'antigravity-ide', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
  ]
  for (const f of agyCandidates) {
    try {
      const st = await fsp.stat(f)
      return { file: f, mtime: st.mtimeMs }
    } catch {
      /* not here */
    }
  }
  return null
}

/** Parse title from Antigravity session annotation file (.pbtxt). */
export function parsePbtxtTitle(content) {
  if (typeof content !== 'string') return ''
  const m = /title\s*:\s*"((?:[^"\\]|\\.)*)"/s.exec(content)
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`).trim()
  } catch {
    return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
  }
}

/** Sync candidate locations for Antigravity summary store. */
function getAntigravitySummaryCandidates() {
  return [
    path.join(HOME, '.gemini', 'antigravity', 'agyhub_summaries_proto.pb'),
    path.join(HOME, '.gemini', 'antigravity-cli', 'agyhub_summaries_proto.pb'),
    path.join(HOME, '.gemini', 'antigravity-ide', 'agyhub_summaries_proto.pb'),
  ]
}

/** Extract map of sessionId -> workspace directory from Antigravity protobuf summary store buffer. */
function extractAntigravityCwdsFromBuffer(buf) {
  const out = new Map()
  if (!buf || !buf.length) return out
  const text = buf.toString('latin1')
  const re = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const sid = m[1].toLowerCase()
    const idx = m.index + m[0].length
    if (idx < buf.length) {
      const len = buf[idx]
      if (len > 7 && idx + 1 + len <= buf.length) {
        const uri = buf.toString('utf8', idx + 1, idx + 1 + len)
        if (uri.startsWith('file://')) {
          out.set(sid, uri.slice(7))
        }
      }
    }
  }
  return out
}

/** Synchronous lookup of Antigravity session working directories. */
export function readAntigravityCwdsSync() {
  for (const f of getAntigravitySummaryCandidates()) {
    try {
      if (fs.existsSync(f)) {
        return extractAntigravityCwdsFromBuffer(fs.readFileSync(f))
      }
    } catch {
      /* not found or unreadable */
    }
  }
  return new Map()
}

/** Asynchronous lookup of Antigravity session working directories. */
export async function readAntigravityCwds() {
  for (const f of getAntigravitySummaryCandidates()) {
    try {
      const buf = await fsp.readFile(f)
      return extractAntigravityCwdsFromBuffer(buf)
    } catch {
      /* not found or unreadable */
    }
  }
  return new Map()
}

/** Candidates for Antigravity annotations file for a given session. */
function getAntigravityCandidatePaths(sessionId, candidatePath = '') {
  if (!sessionId || typeof sessionId !== 'string') return []
  const candidates = []
  if (candidatePath) {
    const brainIdx = candidatePath.search(/[/\\]brain[/\\]/)
    if (brainIdx !== -1) {
      const root = candidatePath.slice(0, brainIdx)
      candidates.push(path.join(root, 'annotations', `${sessionId}.pbtxt`))
    }
  }
  if (process.env.ANTIGRAVITY_HOME) {
    candidates.push(path.join(process.env.ANTIGRAVITY_HOME, 'annotations', `${sessionId}.pbtxt`))
  }
  candidates.push(
    path.join(HOME, '.gemini', 'antigravity', 'annotations', `${sessionId}.pbtxt`),
    path.join(HOME, '.gemini', 'antigravity-cli', 'annotations', `${sessionId}.pbtxt`),
    path.join(HOME, '.gemini', 'antigravity-ide', 'annotations', `${sessionId}.pbtxt`),
  )
  return candidates
}

/** Synchronous lookup for Antigravity session title from annotations. */
export function findAntigravityTitleSync(sessionId, candidatePath = '') {
  for (const f of getAntigravityCandidatePaths(sessionId, candidatePath)) {
    try {
      if (fs.existsSync(f)) {
        const title = parsePbtxtTitle(fs.readFileSync(f, 'utf8'))
        if (title) return title
      }
    } catch {
      /* not found or unreadable */
    }
  }
  return ''
}

/** Async lookup for Antigravity session title from annotations. */
export async function findAntigravityTitle(sessionId, candidatePath = '') {
  for (const f of getAntigravityCandidatePaths(sessionId, candidatePath)) {
    try {
      const content = await fsp.readFile(f, 'utf8')
      const title = parsePbtxtTitle(content)
      if (title) return title
    } catch {
      /* not found or unreadable */
    }
  }
  return ''
}

/** cwd, git branch, title-ish string, and swarm spawnedFrom from the head of a transcript. */
export async function transcriptMeta(file, sessionId = '') {
  const meta = { cwd: '', gitBranch: '', title: '', spawnedFrom: '' }
  let sid = sessionId
  if (!sid && typeof file === 'string') {
    const m = /[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[/\\]/i.exec(file)
    if (m) sid = m[1]
  }
  if (sid) {
    const agyTitle = await findAntigravityTitle(sid, file)
    if (agyTitle) meta.title = agyTitle
  }
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(128 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const rawLines = buf.toString('utf8', 0, bytesRead).split('\n')
    const lines = bytesRead === buf.length || rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
    for (const l of lines) {
      let r
      try {
        r = JSON.parse(l)
      } catch {
        continue
      }
      if (!meta.cwd && (r.cwd || r.workspacePaths?.[0])) meta.cwd = r.cwd || r.workspacePaths[0]
      if (!meta.gitBranch && r.gitBranch && r.gitBranch !== 'HEAD') meta.gitBranch = r.gitBranch
      if (!meta.title) meta.title = r.customTitle || r.aiTitle || (r.type === 'summary' && r.summary) || ''
      if (!meta.title && r.type === 'user' && typeof r.message?.content === 'string' && !r.message.content.startsWith('<')) {
        meta.title = r.message.content.replace(/\s+/g, ' ').slice(0, 80)
      }
      if (!meta.title && (r.type === 'USER_INPUT' || r.source === 'USER_EXPLICIT') && typeof r.content === 'string') {
        const text = r.content.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>[\s\S]*/i, '$1').replace(/\s+/g, ' ').trim()
        if (text && !text.startsWith('<')) {
          meta.title = text.slice(0, 80)
        }
      }
      if (r.type === 'SYSTEM_MESSAGE' && typeof r.content === 'string') {
        const m = /\bsender=([A-Za-z0-9_-]{8,80})\b[\s\S]*?You have just started\.\s*Your assignment \(recorded on the board as #\d+ for (@[A-Za-z0-9_.-]+)\):\s*([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i.exec(r.content)
        if (m) {
          if (!meta.spawnedFrom) meta.spawnedFrom = m[1]
          if (!meta.title) {
            const brief = m[3].replace(/\s+/g, ' ').trim()
            meta.title = (brief ? `${m[2]}: ${brief}` : m[2]).slice(0, 80)
          }
        }
      }
    }
  } catch {
    /* unreadable */
  } finally {
    await fh?.close()
  }
  return meta
}

/** Current branch of a checkout by reading .git/HEAD (handles worktree `.git` files). */
export async function gitBranchOf(cwd) {
  try {
    let gitDir = path.join(cwd, '.git')
    const st = await fsp.stat(gitDir)
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(gitDir, 'utf8'))
      if (!m) return ''
      gitDir = path.resolve(cwd, m[1].trim())
    }
    const head = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] || ''
  } catch {
    return ''
  }
}
