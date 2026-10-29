// Per-model token prices, USD per million tokens, for the Costs view (lib/costs.mjs).
//
// Source: Anthropic's published API pricing, https://platform.claude.com/docs/en/about-claude/pricing
// Checked: 2026-10-29. Edit the table below, or drop overrides in ~/.zarvis/pricing.json (see loadPricing):
//   { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite5m": 5, "cacheWrite1h": 8 } }
// A model with no entry is "unpriced": its tokens are still counted and shown, its cost is left out and flagged.
// Nothing here is guessed. Not modelled (the usage records do not carry enough to price them): the Batch API
// discount, fast mode's premium (Opus 5.5 / 5 / 4.8), the 1.1x US data-residency multiplier, server-tool fees.
//
// `over` is Claude Haiku 5.5's long-prompt tier: a request whose whole prompt (input + cache reads + cache
// writes) is over `over.above` tokens pays the `over` prices instead, priced per request.
import fsp from 'node:fs/promises'
import path from 'node:path'

export const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'
export const PRICING_CHECKED = '2026-10-29'

const p = (input, cacheWrite5m, cacheWrite1h, cacheRead, output, over) => ({ input, cacheWrite5m, cacheWrite1h, cacheRead, output, ...(over ? { over } : {}) })

export const DEFAULT_PRICES = {
  'claude-fable-5-1': p(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': p(10, 12.5, 20, 1, 50),
  'claude-mythos-5-1': p(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5': p(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': p(4, 5, 8, 0.2, 20),
  'claude-opus-5': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-8': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-7': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': p(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': p(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': p(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': p(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': p(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': p(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': p(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': p(0.1, 0.125, 0.2, 0.01, 0.5, { above: 100000, input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 }),
  'claude-haiku-4-5': p(1, 1.25, 2, 0.1, 5),
  'claude-haiku-3-5': p(0.8, 1, 1.6, 0.08, 4),
  'claude-3-5-haiku': p(0.8, 1, 1.6, 0.08, 4), // the older id spelling of the same model
}

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** The override file's entries that are complete and sane; anything else is ignored (never throws). */
export function parseOverrides(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || !/^[A-Za-z0-9._-]{1,80}$/.test(id)) continue
    const price = {}
    for (const f of FIELDS) price[f] = num(v[f])
    if (FIELDS.some((f) => price[f] === null)) continue
    const o = v.over
    if (o && typeof o === 'object' && num(o.above) !== null && FIELDS.every((f) => num(o[f]) !== null)) price.over = Object.fromEntries(['above', ...FIELDS].map((f) => [f, o[f]]))
    out[id.toLowerCase()] = price
  }
  return out
}

/** The default table with ~/.zarvis/pricing.json laid over it. Returns { prices, overridden: [ids], source, checked }. */
export async function loadPricing(home) {
  let overrides = {}
  try {
    overrides = parseOverrides(JSON.parse(await fsp.readFile(path.join(home, 'pricing.json'), 'utf8')))
  } catch {
    /* missing or unreadable: defaults */
  }
  return { prices: { ...DEFAULT_PRICES, ...overrides }, overridden: Object.keys(overrides), source: PRICING_SOURCE, checked: PRICING_CHECKED }
}

/** `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`; also drops a `[1m]`-style suffix. */
export const baseModelId = (model) => String(model ?? '').toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '')

/**
 * The price row for a model id: exact id (date suffix ignored) first, then the longest table id that is a
 * whole-segment prefix of it (`claude-opus-5-9` -> `claude-opus-5`), reported as `match: 'family'` so a caller can
 * say it is approximate. Returns { price, key, match } or null (unpriced).
 */
export function priceFor(model, prices = DEFAULT_PRICES) {
  const id = baseModelId(model)
  if (!id) return null
  if (prices[id]) return { price: prices[id], key: id, match: 'exact' }
  let best = ''
  for (const k of Object.keys(prices)) if (id.startsWith(`${k}-`) && k.length > best.length) best = k
  return best ? { price: prices[best], key: best, match: 'family' } : null
}

/** Dollars for one bucket of tokens at a price row: tokens = { input, output, cacheRead, cacheWrite5m, cacheWrite1h }. */
export function costOf(tokens, price) {
  const per = (n, rate) => ((n || 0) * rate) / 1e6
  return per(tokens.input, price.input) + per(tokens.output, price.output) + per(tokens.cacheRead, price.cacheRead) + per(tokens.cacheWrite5m, price.cacheWrite5m) + per(tokens.cacheWrite1h, price.cacheWrite1h)
}

/** The price row that applies to one request (the long-prompt tier when its prompt is over the threshold). */
export function tierFor(price, promptTokens) {
  return price.over && promptTokens > price.over.above ? price.over : price
}
