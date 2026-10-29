'use strict'
// Costs view: pure helpers (formatting, model colours, bar maths). No DOM. The numbers come from /api/costs; every dollar
// shown is an API-equivalent estimate (tokens x published API list prices), never what a subscription is billed.

export const RANGES = [
  { id: 'today', label: 'today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'all' },
]
export const DEFAULT_RANGE = '7d'
export const rangeOf = (id) => RANGES.find((r) => r.id === id) || RANGES.find((r) => r.id === DEFAULT_RANGE)
/** The range `dir` steps away (+1 = longer); stops at the ends. */
export function stepRange(id, dir) {
  const i = Math.max(0, RANGES.findIndex((r) => r.id === id))
  return RANGES[Math.min(RANGES.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)))].id
}

/** $1,234 / $12.34 / $0.123 — more precision the smaller it is. */
export function usd(n) {
  n = Number(n) || 0
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return n > 0 ? `$${n.toFixed(3)}` : '$0'
}

/** 1.2B / 3.4M / 5.6k / 789 */
export function tok(n) {
  n = Number(n) || 0
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))
}

/** The model family for colouring: fable | mythos | opus | sonnet | haiku | other. */
export function familyOf(model) {
  const m = /claude-(fable|mythos|opus|sonnet|haiku)/.exec(String(model ?? '').toLowerCase())
  return m ? m[1] : 'other'
}

/** A short label: claude-opus-5-5 -> "opus 5.5"; an unknown id is kept as given. */
export function modelLabel(model) {
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(model ?? '').toLowerCase())
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : String(model ?? '')
}

/** A model mix as segments of a bar: [{ model, family, label, pct, priced }], by tokens-weighted dollars, falling back to tokens when nothing is priced. */
export function mixSegments(models) {
  const byCost = models.some((m) => m.cost > 0)
  const w = (m) => (byCost ? m.cost : m.totalTokens)
  const total = models.reduce((a, m) => a + w(m), 0)
  if (!total) return []
  return models.filter((m) => w(m) > 0).map((m) => ({ model: m.model, family: m.priced ? familyOf(m.model) : 'other', label: modelLabel(m.model), pct: (w(m) / total) * 100, priced: m.priced }))
}

/** Bar heights (0..1) for a daily series, scaled to the largest day in `max` (so projects share a scale when asked). */
export function dayBars(days, max = Math.max(0, ...days.map((d) => d.cost))) {
  return days.map((d) => (max > 0 ? Math.min(1, d.cost / max) : 0))
}

/** Share of `part` in `whole`, 0..100, safe on zero. */
export const share = (part, whole) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0)

/** "Mar 3" for a YYYY-MM-DD key (local), for bar titles. */
export function dayLabel(key) {
  const [y, m, d] = String(key).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Move a selection index through `n` rows, stopping at the ends. */
export const stepIndex = (i, n, d) => (n ? Math.min(n - 1, Math.max(0, i + d)) : 0)
