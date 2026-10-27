// Approximate context-window usage per session, from the tail of its transcript.
//
// The last real assistant message carries `message.usage`; input + cache_read + cache_creation tokens is the
// context that turn sent. The window size is NOT recorded anywhere Zarvis can read (model ids carry no 1M
// marker and sessions already run past 200k), so the percentage is against a stated reference window
// (ZARVIS_CONTEXT_WINDOW, default 1,000,000) and the UI says "~". The token count itself is exact.
// Read-only, tail only, cached by path + mtime + size. Never throws.
import fsp from 'node:fs/promises'

export const DEFAULT_WINDOW = 1_000_000
export const TAIL_BYTES = 256 * 1024
export const AMBER_PCT = 70
export const RED_PCT = 90

/** The reference window: a positive integer from the environment, else the default. */
export function contextWindow(env = process.env) {
  const raw = String(env.ZARVIS_CONTEXT_WINDOW ?? '').trim()
  if (!/^\d+$/.test(raw)) return DEFAULT_WINDOW
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_WINDOW
}

/** Tokens sent on the last real assistant turn in a transcript tail, or null (no usage yet). Skips sidechains and synthetic records. */
export function lastUsageTokens(tailText) {
  const lines = tailText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let r
    try {
      r = JSON.parse(lines[i])
    } catch {
      continue // the partial first line of a tail, or junk
    }
    const m = r?.message
    if (r?.type !== 'assistant' || r.isSidechain || !m || typeof m !== 'object' || m.model === '<synthetic>' || !m.usage) continue
    const u = m.usage
    const n = (k) => (Number.isFinite(u[k]) && u[k] >= 0 ? u[k] : 0)
    const tokens = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens')
    return tokens > 0 ? tokens : null
  }
  return null
}

/**
 * { tokens, window, pct, level, label, winLabel } for a token count: pct is an integer (can pass 100 on a small
 * reference), level '' | 'amber' | 'red', label like "235k" and winLabel like "1M" for the UI (it never formats numbers itself).
 */
export function ctxView(tokens, window = DEFAULT_WINDOW) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  const exact = (tokens / window) * 100 // thresholds use the exact share, so rounding never tips a level
  return { tokens, window, pct: Math.round(exact), level: exact >= RED_PCT ? 'red' : exact >= AMBER_PCT ? 'amber' : '', label: compactTokens(tokens), winLabel: compactTokens(window) }
}

/** "235k", "1.2M": a compact token count. */
export function compactTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

const cache = new Map() // file -> { key: 'mtime:size', tokens }

/** Tokens for a transcript file (cached by mtime + size), or null: missing, unreadable, or no usage yet. */
export async function contextTokens(file) {
  if (!file || typeof file !== 'string') return null
  try {
    const st = await fsp.stat(file)
    const key = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(file)
    if (hit && hit.key === key) return hit.tokens
    const len = Math.min(st.size, TAIL_BYTES)
    const fh = await fsp.open(file, 'r')
    let text
    try {
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, st.size - len)
      text = buf.toString('utf8')
    } finally {
      await fh.close()
    }
    const tokens = lastUsageTokens(text)
    if (cache.size > 2000) cache.clear()
    cache.set(file, { key, tokens })
    return tokens
  } catch {
    return null
  }
}

/** The ctx object for a transcript file, or null (never a zero). */
export async function contextOf(file, window = contextWindow()) {
  return ctxView(await contextTokens(file), window)
}
