// Read-only view of the Claude desktop app's session records and CLI transcripts.
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

/** Find ~/.claude/projects/<encoded-cwd>/<id>.jsonl without knowing the encoding. */
export async function findTranscript(sessionId, root = CLI_PROJECTS) {
  if (!UUID.test(sessionId)) return null
  for (const d of await dirs(root)) {
    const f = path.join(d, `${sessionId}.jsonl`)
    try {
      const st = await fsp.stat(f)
      return { file: f, mtime: st.mtimeMs }
    } catch {
      /* not here */
    }
  }
  return null
}

/** cwd, git branch and a title-ish string from the head of a transcript. */
export async function transcriptMeta(file) {
  const meta = { cwd: '', gitBranch: '', title: '' }
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(128 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const lines = buf.toString('utf8', 0, bytesRead).split('\n').slice(0, -1)
    for (const l of lines) {
      let r
      try {
        r = JSON.parse(l)
      } catch {
        continue
      }
      if (!meta.cwd && r.cwd) meta.cwd = r.cwd
      if (!meta.gitBranch && r.gitBranch && r.gitBranch !== 'HEAD') meta.gitBranch = r.gitBranch
      if (!meta.title) meta.title = r.customTitle || r.aiTitle || (r.type === 'summary' && r.summary) || ''
      if (!meta.title && r.type === 'user' && typeof r.message?.content === 'string' && !r.message.content.startsWith('<')) {
        meta.title = r.message.content.replace(/\s+/g, ' ').slice(0, 80)
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
