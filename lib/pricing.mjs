// Per-model token prices, USD per million tokens, for the Costs view (lib/costs.mjs).
//
// Sources:
//   - Anthropic published API pricing: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-29)
//   - Google Cloud / Gemini API published pricing: https://ai.google.dev/pricing (checked 2026-11-18)
// Edit the table below, or drop overrides in ~/.zarvis/pricing.json (see loadPricing):
//   { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite5m": 5, "cacheWrite1h": 8 } }
// A model with no entry is "unpriced": its tokens are still counted and shown, its cost is left out and flagged.
// Rates match published list prices. Not modelled (usage records do not carry enough to price them): Batch API
// discounts, fast mode premiums, regional data-residency multipliers, and server-tool fees.
//
// `over` is Claude Haiku 5.5's / Gemini Pro's long-prompt tier: a request whose whole prompt (input + cache reads + cache
// writes) is over `over.above` tokens pays the `over` prices instead, priced per request.
// `dated` specifies rate steps that activate after a specific UTC timestamp (e.g. promotional intro rate expiration).
import fsp from 'node:fs/promises'
import path from 'node:path'

export const PROVIDER_PRICING = {
  anthropic: {
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    checked: '2026-10-29',
  },
  gcp: {
    source: 'https://ai.google.dev/pricing',
    checked: '2026-11-18',
  },
}

export const PRICING_SOURCE = PROVIDER_PRICING.anthropic.source
export const PRICING_CHECKED = PROVIDER_PRICING.anthropic.checked

export const PROVIDERS = ['all', 'anthropic', 'gcp']
export const normalizeProvider = (p) => {
  const s = String(p ?? '').toLowerCase()
  return PROVIDERS.includes(s) ? s : 'all'
}

/** Provider of a model or session ('gcp' for Gemini / Antigravity, 'anthropic' for Claude). */
export function providerOf(model, runtime = '') {
  const m = String(model ?? '').toLowerCase()
  if (m.startsWith('gemini-') || m.startsWith('gpt-')) return 'gcp'
  if (m.startsWith('claude-')) return 'anthropic'
  return runtime === 'antigravity' ? 'gcp' : 'anthropic'
}

const p = (input, cacheWrite5m, cacheWrite1h, cacheRead, output, over, dated) => ({
  input,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  output,
  ...(over ? { over } : {}),
  ...(dated ? { dated } : {}),
})

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
  // Google / GCP Gemini models used by Antigravity (USD per 1M tokens: input, cacheWrite5m, cacheWrite1h, cacheRead, output)
  // Source: https://ai.google.dev/pricing (checked 2026-11-18)
  'gemini-4-argon': p(2.5, 0, 0, 0.25, 15, { above: 200000, input: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5, output: 22.5 }),
  'gemini-4-carbon': p(2.5, 0, 0, 0.25, 15, { above: 200000, input: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5, output: 22.5 }),
  'gemini-4-hydrogen': p(0.75, 0, 0, 0.075, 3.75),
  // Gemini 3.8/3.7/3.6 Flash: promotional intro rates through 2026-12-31 ($0.75 in / $3.75 out / $0.075 cache read),
  // stepping to standard rates on 2027-01-01 ($1.50 in / $7.50 out / $0.15 cache read).
  'gemini-3.8-flash': p(0.75, 0, 0, 0.075, 3.75, null, { after: Date.UTC(2027, 0, 1), input: 1.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15, output: 7.5 }),
  'gemini-3.7-flash': p(0.75, 0, 0, 0.075, 3.75, null, { after: Date.UTC(2027, 0, 1), input: 1.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15, output: 7.5 }),
  'gemini-3.6-flash': p(0.75, 0, 0, 0.075, 3.75, null, { after: Date.UTC(2027, 0, 1), input: 1.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15, output: 7.5 }),
  'gemini-3.5-flash-lite': p(0.3, 0, 0, 0.03, 2.5),
  'gemini-3.5-flash': p(0.75, 0, 0, 0.075, 3.75, null, { after: Date.UTC(2027, 0, 1), input: 1.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15, output: 7.5 }),
  'gemini-3.1-ultra': p(5, 0, 0, 0.5, 25),
  'gemini-3.1-pro': p(2, 0, 0, 0.2, 12, { above: 200000, input: 4, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.2, output: 18 }),
  'gemini-3.1-flash-lite': p(0.3, 0, 0, 0.03, 2.5),
  'gemini-3.1-flash': p(0.75, 0, 0, 0.075, 3.75, null, { after: Date.UTC(2027, 0, 1), input: 1.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15, output: 7.5 }),
  'gemini-3-pro': p(2, 0, 0, 0.2, 12, { above: 200000, input: 4, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.2, output: 18 }),
  'gemini-3-flash': p(0.75, 0, 0, 0.075, 3.75, null, { after: Date.UTC(2027, 0, 1), input: 1.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15, output: 7.5 }),
  'gemini-2.5-pro': p(1.25, 0, 0, 0.125, 10, { above: 200000, input: 2.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.25, output: 15 }),
  'gemini-2.5-flash-lite': p(0.1, 0, 0, 0.01, 0.4),
  'gemini-2.5-flash': p(0.3, 0, 0, 0.07, 2.5),
  'gemini-2.0-flash': p(0.1, 0, 0, 0.025, 0.4),
  'gemini-auto': p(0.75, 0, 0, 0.075, 3.75, null, { after: Date.UTC(2027, 0, 1), input: 1.5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.15, output: 7.5 }),
  // Orchestrator pairs Carbon/Argon planner with Hydrogen implementation
  'gemini-orchestrator': p(2.5, 0, 0, 0.25, 15, { above: 200000, input: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5, output: 22.5 }),
  'gemini-pro-orchestrator-g1-pro': p(2.5, 0, 0, 0.25, 15, { above: 200000, input: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5, output: 22.5 }),
  // Open-weights frontier model hosted on GCP for Antigravity
  'gpt-oss-120b': p(0.3, 0, 0, 0.03, 1.2),
  'gpt-oss-120b-medium': p(0.3, 0, 0, 0.03, 1.2),
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

/** The default table with ~/.zarvis/pricing.json laid over it. Returns { prices, overridden: [ids], source, checked, providers }. */
export async function loadPricing(home) {
  let overrides = {}
  try {
    overrides = parseOverrides(JSON.parse(await fsp.readFile(path.join(home, 'pricing.json'), 'utf8')))
  } catch {
    /* missing or unreadable: defaults */
  }
  return {
    prices: { ...DEFAULT_PRICES, ...overrides },
    overridden: Object.keys(overrides),
    source: PRICING_SOURCE,
    checked: PRICING_CHECKED,
    providers: PROVIDER_PRICING,
  }
}

/** `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`; drops `[1m]`, date, `-latest`, and Gemini suffixes (`-trial`, `-tiered`, `-n`, `-low`, `-medium`, `-high`, `-xhigh`, `-extra-low`). */
export const baseModelId = (model) =>
  String(model ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '')
    .replace(/-trial$/, '')
    .replace(/-tiered$/, '')
    .replace(/-(low|medium|high|xhigh|extra-low|extra_low)$/, '')
    .replace(/-tiered$/, '')
    .replace(/-n$/, '')

/**
 * The price row for a model id: exact id (date suffix ignored) first, then the longest table id that is a
 * whole-segment prefix of it (`claude-opus-5-9` -> `claude-opus-5`), reported as `match: 'family'` so a caller can
 * say it is approximate. Gemini models require an exact table entry and never silently family-match.
 * If `ts` (epoch ms) is provided, date-stepped rates (e.g. promo rate expiration) are resolved.
 * Returns { price, key, match } or null (unpriced).
 */
export function priceFor(model, prices = DEFAULT_PRICES, ts = null) {
  const id = baseModelId(model)
  if (!id) return null
  let hit = null
  if (prices[id]) hit = { price: prices[id], key: id, match: 'exact' }
  else {
    let best = ''
    for (const k of Object.keys(prices)) {
      if (k.startsWith('claude-') && id.startsWith(`${k}-`) && k.length > best.length) best = k
    }
    if (best) hit = { price: prices[best], key: best, match: 'family' }
  }
  if (!hit) return null
  if (hit.price.dated && typeof ts === 'number' && ts >= hit.price.dated.after) {
    const { dated, over, ...base } = hit.price
    hit = { ...hit, price: { ...base, ...dated, ...(over ? { over } : {}) } }
  }
  return hit
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
