// Pure state for the HUD effects (fuse, ambient glow, tab title, ticker). No DOM in here, so it is unit-tested.
import { liveProjectNames } from './projects.js'

/** A blocked row that counts toward "needs you": blocked (permission or question) and not parked. */
export const needsYou = (r) => r.state === 'blocked' && !r.parked

/**
 * Wait-fuse inputs for one row: `p` is the elapsed fraction of the overdue window (0..1) and `d` the
 * negative animation delay that starts a CSS animation at that point, so it survives list redraws.
 */
export function fuseVars(since, now, overdueMs) {
  const e = Math.min(overdueMs, Math.max(0, now - since))
  return { p: Number((e / overdueMs).toFixed(3)), d: `-${(e / 1000).toFixed(1)}s` }
}

/** The ambient edge glow: '' (nothing blocked), 'blocked' (amber) or 'overdue' (red). */
export function glowState(rows, now, overdueMs) {
  let state = ''
  for (const r of rows) {
    if (!needsYou(r)) continue
    if (now - r.since > overdueMs) return 'overdue'
    state = 'blocked'
  }
  return state
}

/** Tab-level attention state from the rows: how many need you and whether any wait is overdue. */
export function attention(rows, now, overdueMs) {
  const blocked = rows.filter(needsYou)
  return { count: blocked.length, overdue: blocked.some((r) => now - r.since > overdueMs) }
}

/** "(3!) Zarvis": the count in parentheses, `!` once overdue; plain "Zarvis" when nothing needs you. */
export const tabTitle = ({ count, overdue }) => (count ? `(${count}${overdue ? '!' : ''}) Zarvis` : 'Zarvis')

/** What the favicon shows. `key` changes only when the picture would, so the canvas is redrawn rarely. */
export function faviconState({ count, overdue }) {
  const color = !count ? 'idle' : overdue ? 'red' : 'amber'
  const label = count > 9 ? '9+' : count ? String(count) : ''
  return { color, label, key: `${color}:${label}` }
}

/** What the ticker remembers about each session between pushes. */
export const snapshot = (rows) => new Map(rows.map((r) => [r.sessionId, { state: r.state, parked: !!r.parked }]))

/**
 * State transitions between the last snapshot and `rows`: arrived, blocked, unblocked (resumed), finished
 * and parked. `prev` null (the first load) yields nothing: that is not news. Each event: { kind, id, text }.
 */
export function diffEvents(prev, rows) {
  if (!prev) return []
  const out = []
  for (const r of rows) {
    const p = prev.get(r.sessionId)
    const ev = (kind, text) => out.push({ kind, id: r.sessionId, text: `${r.name} ${text}` })
    if (!p) { ev('arrived', 'appeared'); continue }
    const wasBlocked = p.state === 'blocked' && !p.parked
    const isBlocked = needsYou(r)
    if (!p.parked && r.parked) ev('parked', 'parked')
    else if (!wasBlocked && isBlocked) ev('blocked', r.kind === 'question' ? 'asks a question' : `needs you${r.tool ? ` · ${r.tool}` : ''}`)
    else if (wasBlocked && !isBlocked && !r.parked) ev(r.state === 'idle' ? 'finished' : 'resumed', r.state === 'idle' ? 'finished' : 'resumed')
    else if (p.state === 'working' && r.state === 'idle') ev('finished', 'finished')
  }
  return out
}

export const TICKER_MAX = 40 // history kept; the strip scrolls through it as soon as it overflows
const pad = (n) => String(n).padStart(2, '0')

/** Identity of a ticker entry: pushed events are de-duplicated on (at, sessionId, text). Local transitions carry their own `key`. */
export const evKey = (e) => e.key ?? `${e.at}|${e.sessionId || ''}|${e.text}`

/**
 * Merge `incoming` into the ticker's `items` (both newest-first for `items`, oldest-first for `incoming`, as the server
 * and diffEvents emit them): drops ones already shown, orders by time with the newest first, keeps `max`.
 * Returns { items, added } where `added` are the new entries that made it into the list.
 */
export function mergeTicker(items, incoming, max = TICKER_MAX) {
  const have = new Set(items.map(evKey))
  const fresh = []
  for (const e of incoming) {
    const k = evKey(e)
    if (have.has(k)) continue
    have.add(k)
    fresh.unshift({ ...e, key: k })
  }
  const merged = [...fresh, ...items].sort((a, b) => b.at - a.at).slice(0, max) // sort is stable: ties keep fresh first
  const kept = new Set(merged)
  return { items: merged, added: fresh.filter((e) => kept.has(e)) }
}

/** Clock time for a ticker entry; an entry from an earlier day gets the date in front. */
export function evTime(at, now = Date.now()) {
  const d = new Date(at)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return d.toDateString() === new Date(now).toDateString() ? t : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}`
}

const KNOWN_KINDS = ['push', 'pr', 'done', 'warn', 'info']
/** CSS class for a pushed event's kind: the known kinds as themselves, any other word as the neutral 'other'. */
export const evKindClass = (kind) => (KNOWN_KINDS.includes(kind) ? kind : 'other')

/** An http(s) URL to link to, or ''. The server already checks; the browser does too, since the text is untrusted. */
export const safeUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(String(u ?? '')) && String(u).length <= 300 ? String(u) : '')

export const TICKER_SCROLL_MIN = 0 // the strip scrolls as soon as its entries overflow the width, however few they are
export const TICKER_PAUSE_MS = 5000 // rest on the newest entry before the scroll restarts
export const TICKER_SPEED = 80 // px per second
export const TICKER_MAX_PASS_MS = 45000 // a long history speeds up rather than taking longer than this to cross

/**
 * Whether and how the ticker scrolls. Entries are newest first, so the scroll starts at the oldest end
 * (the content shifted left by `distance`) and moves right until the newest entry is in view.
 * A pass takes at most `maxMs` (long histories scroll faster than `speed`).
 * No scrolling with `minCount` entries or fewer, when everything fits, or when `reduced` (reduced motion).
 */
export function scrollPlan({ count, contentW, viewW, reduced = false, minCount = TICKER_SCROLL_MIN, speed = TICKER_SPEED, maxMs = TICKER_MAX_PASS_MS }) {
  const distance = Math.max(0, Math.round(contentW - viewW))
  if (reduced || count <= minCount || viewW <= 0 || distance <= 0) return { scroll: false, distance: 0, duration: 0 }
  return { scroll: true, distance, duration: Math.min(maxMs, Math.round((distance / speed) * 1000)) }
}

/** The reactor ring's circle radius and circumference (SVG user units; the viewBox is 40x40). */
export const REACTOR_R = 15
export const REACTOR_C = 2 * Math.PI * REACTOR_R

/**
 * Counts for the arc reactor: blocked (= needsYou: unparked, blocked), working (working or waiting on a
 * worker), idle, and parked (any parked row that is not already needs-you, or `parkedTotal` when given).
 * Rows with no signal count nowhere.
 */
export function reactorCounts(rows, parkedTotal = null) {
  const c = { blocked: 0, working: 0, idle: 0, parked: 0 }
  for (const r of rows) {
    if (needsYou(r)) c.blocked++
    else if (r.parked) c.parked++
    else if (r.state === 'working' || r.state === 'waiting_on_child') c.working++
    else if (r.state === 'idle') c.idle++
  }
  // Parked sessions mostly leave the queue, so the caller may pass the real total (from the tree).
  if (parkedTotal !== null) c.parked = parkedTotal
  return c
}

/**
 * The four arc segments: for each of blocked / working / idle / parked, its share of the ring as a
 * stroke-dasharray ("len gap") and stroke-dashoffset, laid end to end from the top. A tiny gap keeps
 * neighbouring arcs apart. No sessions at all gives four zero-length arcs.
 */
export function reactorArcs(counts, circumference = REACTOR_C, gap = 1.2) {
  const keys = ['blocked', 'working', 'idle', 'parked']
  const total = keys.reduce((s, k) => s + (counts[k] || 0), 0)
  const live = keys.filter((k) => counts[k] > 0).length
  let used = 0
  return keys.map((k) => {
    const share = total ? counts[k] / total : 0
    const len = Math.max(0, share * circumference - (live > 1 && share ? gap : 0))
    const arc = { key: k, frac: Number(share.toFixed(4)), dash: `${len.toFixed(2)} ${(circumference - len).toFixed(2)}`, offset: (-used).toFixed(2) }
    used += share * circumference
    return arc
  })
}

/** Core and ring state: pulse colour ('' calm, 'amber' needs you, 'red' overdue) and whether the outer ring turns. */
export function reactorState(counts, att) {
  return { core: !att.count ? '' : att.overdue ? 'red' : 'amber', spin: counts.working > 0 }
}

/** The readout beside the core: "2 need · 3 run", or "idle" when nothing is live. */
export function reactorText(counts) {
  const parts = []
  if (counts.blocked) parts.push(`${counts.blocked} need`)
  if (counts.working) parts.push(`${counts.working} run`)
  return parts.join(' · ') || 'calm'
}

// ---- Stat dials (header) and the project gauge rail ----

export const DIAL_R = 11
export const DIAL_C = 2 * Math.PI * DIAL_R

/** stroke-dasharray for a ring filled to `p` (0..1). */
export const dialDash = (p, c = DIAL_C) => `${(Math.min(1, Math.max(0, p)) * c).toFixed(2)} ${c.toFixed(2)}`

/** "42s", "7m", "3h": the shortest honest form of a wait, for a 26px dial. */
export function compactWait(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

/**
 * The longest-wait dial: the oldest needs-you row, as a share of the overdue window (full ring = overdue).
 * { p, text, state: '' | 'amber' | 'red', count }; nothing blocked reads "—" with an empty ring.
 */
export function waitDial(rows, now, overdueMs) {
  const blocked = rows.filter(needsYou)
  if (!blocked.length) return { p: 0, text: '—', state: '', count: 0 }
  const wait = now - Math.min(...blocked.map((r) => r.since))
  return { p: Math.min(1, Math.max(0, wait / overdueMs)), text: compactWait(wait), state: wait > overdueMs ? 'red' : 'amber', count: blocked.length }
}

/** The hook-status dial: live is a full green ring, stale a half amber one, absent or unknown an empty grey one. */
export function hookDial(status) {
  if (status === 'live') return { p: 1, state: 'live' }
  if (status === 'stale') return { p: 0.5, state: 'stale' }
  return { p: 0, state: status === 'absent' ? 'absent' : 'unknown' }
}

/**
 * One gauge per live project for the rail (see liveProjectNames): its session mix as reactor arcs plus the counts,
 * blocked-first. `parked` is the tree's total for the project (archived ones included), since parked sessions
 * mostly leave the queue; it still counts for a project that stays visible.
 */
export function projectGauges(rows, nodes = []) {
  const names = liveProjectNames(rows, nodes) // a project with only parked or archived sessions has no gauge
  const gauges = [...names].map((project) => {
    const mine = rows.filter((r) => r.project === project && r.role !== 'interface')
    const parked = nodes.filter((n) => n.project === project && n.role !== 'interface' && n.parked && !n.done).length
    const counts = reactorCounts(mine, parked)
    return { project, counts, arcs: reactorArcs(counts), total: counts.blocked + counts.working + counts.idle + counts.parked }
  })
  return gauges.sort((a, b) => b.counts.blocked - a.counts.blocked || b.counts.working - a.counts.working || a.project.localeCompare(b.project))
}

// ---- The interface session inside its big ring ----

export const IFACE_R = 88
export const IFACE_C = 2 * Math.PI * IFACE_R

/**
 * What the interface ring shows for a row: `state` (blocked / working / idle / off for no signal / child for
 * waiting on a worker), the label under the name, `p` (a blocked wait as a share of the overdue window, else 0)
 * and `od` once overdue. Never guesses: a row with no hook signal is "no signal" (the app shuts idle sessions down, so a live one can lack markers).
 */
export function ifaceRing(r, now, overdueMs) {
  if (r.state === 'blocked') {
    const wait = Math.max(0, now - r.since)
    return { state: 'blocked', label: r.kind === 'question' ? 'asks a question' : 'needs you', p: Math.min(1, wait / overdueMs), od: wait > overdueMs && !r.parked }
  }
  if (r.state === 'waiting_on_child') return { state: 'child', label: 'waiting on a worker', p: 0, od: false }
  if (r.state === 'working') return { state: 'working', label: 'working', p: 0, od: false }
  if (r.state === 'idle') return { state: 'idle', label: 'idle', p: 0, od: false }
  return { state: 'off', label: 'no signal', p: 0, od: false }
}

/** A negative CSS animation delay that keeps a looping animation continuous across redraws of its element. */
export const loopDelay = (now, periodMs) => `-${(now % periodMs) / 1000}s`

// ---- Idle telemetry: clock and a needs-you sparkline ----

export const SPARK_MAX = 60 // samples kept (one per 5s: five minutes)

/** HH:MM:SS for the header clock. */
export const clockText = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Append a sample, keeping the newest SPARK_MAX. */
export const pushSample = (samples, v, max = SPARK_MAX) => [...samples, v].slice(-max)

/**
 * Polyline points for a w x h sparkline of `samples`, newest at the right, scaled to the largest value
 * (at least 1, so a flat zero line sits on the baseline). Fewer than two samples: just the baseline.
 */
export function sparkPoints(samples, w, h, pad = 1) {
  if (samples.length < 2) return `${pad},${h - pad} ${w - pad},${h - pad}`
  const top = Math.max(1, ...samples)
  const step = (w - pad * 2) / (samples.length - 1)
  return samples.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - (v / top) * (h - pad * 2)).toFixed(1)}`).join(' ')
}

// ---- Pagination: the dashboard never scrolls; lists are cut into pages that fit the window ----

/**
 * Cut a list into pages by measured heights. `heights[i]` is item i's height including its margin, `heads[i]`
 * marks a section heading (never left stranded at the bottom of a page: it moves to the next page with its
 * first row). Every page holds at least one item, so a row taller than the window still gets a page.
 * Returns [[start, end), …]; an empty list is one empty page.
 */
export function paginate(heights, heads, avail) {
  const n = heights.length
  if (!n) return [[0, 0]]
  const pages = []
  let s = 0
  while (s < n) {
    let e = s
    let sum = 0
    while (e < n && (e === s || sum + heights[e] <= avail)) sum += heights[e++]
    if (e < n && e - 1 > s && heads[e - 1]) e-- // a heading is never the last thing on a page
    pages.push([s, e])
    s = e
  }
  return pages
}

export const clampPage = (page, count) => Math.min(Math.max(0, count - 1), Math.max(0, page | 0))

/** The page that holds item `index`, or -1. */
export const pageOfIndex = (pages, index) => pages.findIndex(([s, e]) => index >= s && index < e)

/** The first selectable (non-heading) item on a page, or -1. */
export function firstRowOn(pages, heads, page) {
  const [s, e] = pages[page] || [0, 0]
  for (let i = s; i < e; i++) if (!heads[i]) return i
  return -1
}

const RANK = { '': 0, amber: 1, red: 2 }

/** Per page: the most urgent flag ('' | 'amber' | 'red') among its items; `flags[i]` is that item's own. */
export const pageFlags = (pages, flags) => pages.map(([s, e]) => flags.slice(s, e).reduce((w, f) => (RANK[f] > RANK[w] ? f : w), ''))

/** The most urgent flag on any page other than `current`: what the pager has to signal. */
export const flagElsewhere = (perPage, current) => perPage.reduce((w, f, i) => (i !== current && RANK[f] > RANK[w] ? f : w), '')

/**
 * Wheel / swipe to page flip, debounced: a flip needs |delta| past the threshold and a quiet cooldown since the
 * last flip, so a trackpad's momentum tail does not fly through the pages. Returns -1 (previous), 0 or 1 (next).
 */
export function wheelFlip({ dx = 0, dy = 0, now, lastFlipAt = 0, threshold = 40, cooldown = 380 }) {
  if (now - lastFlipAt < cooldown) return 0
  const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx
  if (Math.abs(d) < threshold) return 0
  return d > 0 ? 1 : -1
}

/** "PAGE 2/4" */
export const pageLabel = (page, count) => `PAGE ${page + 1}/${count}`

/** How many fixed-height items fit in `avail` px (at least 1): for the palette results, the rail and the pickers. */
export const fitCount = (avail, itemHeight) => Math.max(1, Math.floor(avail / Math.max(1, itemHeight)))

/** A window of `size` items from `total` that keeps `index` in view, as [start, end). */
export function windowAround(index, total, size) {
  if (total <= size) return [0, total]
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), total - size)
  return [start, start + size]
}
