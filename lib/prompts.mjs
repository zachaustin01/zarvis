// What a session was asked to do and what it last said, from its transcript: the text the session
// search matches on top of names and branches. Read-only, head and tail only, cached by path + mtime + size.
// Never throws; a missing or unreadable transcript is just empty text.
import fsp from 'node:fs/promises'
import { findTranscript, UUID } from './sessions.mjs'

export const HEAD_BYTES = 256 * 1024
export const TAIL_BYTES = 256 * 1024
export const MAX_CHARS = 1200

const squash = (s) => s.replace(/\s+/g, ' ').trim()

/** Plain text of a message `content` (a string, or an array of blocks: only `text` blocks count). */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

// Machine-added user turns (IDE context, command echoes, hook output) are not the user's request.
const SYSTEM_TURN = /^<(system-reminder|command-|local-command|ide_|user-prompt-submit-hook|task-notification)/

/** The first real user prompt in a transcript head (JSONL text), or ''. Skips sidechains, tool results and system-added turns. */
export function firstPrompt(headText) {
  for (const l of headText.split('\n')) {
    let r
    try {
      r = JSON.parse(l)
    } catch {
      continue
    }
    if (r?.type !== 'user' || r.isSidechain || r.isMeta || r.toolUseResult) continue
    const t = squash(textOf(r.message?.content))
    if (t && !SYSTEM_TURN.test(t)) return t.slice(0, MAX_CHARS)
  }
  return ''
}

/** The last assistant text in a transcript tail (JSONL text), or ''. Skips sidechains, synthetic records and tool-only turns. */
export function lastReply(tailText) {
  const lines = tailText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let r
    try {
      r = JSON.parse(lines[i])
    } catch {
      continue // the partial first line of a tail, or junk
    }
    if (r?.type !== 'assistant' || r.isSidechain || r.message?.model === '<synthetic>') continue
    const t = squash(textOf(r.message?.content))
    if (t) return t.slice(0, MAX_CHARS)
  }
  return ''
}

const cache = new Map() // file -> { key, text }

async function readRange(fh, pos, len) {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, pos)
  return buf.toString('utf8', 0, bytesRead)
}

/** { prompt, reply } for a transcript file (cached by mtime + size). Both '' when there is nothing to read. */
export async function promptsOf(file) {
  const empty = { prompt: '', reply: '' }
  if (!file || typeof file !== 'string') return empty
  try {
    const st = await fsp.stat(file)
    const key = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(file)
    if (hit && hit.key === key) return hit.text
    const fh = await fsp.open(file, 'r')
    let text
    try {
      const head = await readRange(fh, 0, Math.min(st.size, HEAD_BYTES))
      const prompt = firstPrompt(head.slice(0, head.lastIndexOf('\n') + 1) || head)
      const tailLen = Math.min(st.size, TAIL_BYTES)
      const reply = lastReply(await readRange(fh, st.size - tailLen, tailLen))
      text = { prompt, reply }
    } finally {
      await fh.close()
    }
    if (cache.size > 2000) cache.clear()
    cache.set(file, { key, text })
    return text
  } catch {
    return empty
  }
}

/** { prompt, reply } for a CLI session id: finds its transcript first. */
export async function promptsForSession(sessionId, find = findTranscript) {
  if (!UUID.test(String(sessionId))) return { prompt: '', reply: '' }
  return promptsOf((await find(sessionId))?.file)
}
