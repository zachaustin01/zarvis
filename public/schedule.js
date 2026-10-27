'use strict'
// Schedule view: pure layout maths (no DOM). The track is one strip per lane, wider than the window, laid out once
// from a base time and slid with a single transform computed from the clock; ticks never move inside it.
//
//   |<- PAST_FRAC ->|NOW|<-------- the rest of the window -------->|<- extra ->|
//   base            now0                                                         base + trackMs
import { fitCount } from './fx.js'

const HOUR = 3600000
export const ZOOMS = [
  { id: '3h', ms: 3 * HOUR },
  { id: '12h', ms: 12 * HOUR },
  { id: '24h', ms: 24 * HOUR },
  { id: '7d', ms: 7 * 24 * HOUR },
]
export const DEFAULT_ZOOM = '12h'
/** Share of the window shown to the left of the NOW marker, so a run that just fired is still visible. */
export const PAST_FRAC = 0.08
/** The track reaches this far beyond the window so it can keep sliding between refetches. */
export const TRACK_AHEAD = 1.15
/** A run closer than this to the next one is amber. */
export const SOON_MS = 5 * 60 * 1000

export const zoomOf = (id) => ZOOMS.find((z) => z.id === id) || ZOOMS.find((z) => z.id === DEFAULT_ZOOM)
/** The zoom `dir` steps away (+1 = wider window); stops at the ends rather than looping. */
export function stepZoom(id, dir) {
  const i = Math.max(0, ZOOMS.findIndex((z) => z.id === id))
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)))].id
}

/** Track geometry for a window of `span` ms fetched at `now0`: { base, trackMs }. */
export function trackGeom(now0, span) {
  return { base: now0 - span * PAST_FRAC, trackMs: span * (TRACK_AHEAD + PAST_FRAC) }
}
/** A time's left offset on the track, in percent of the track. */
export const posPct = (t, base, trackMs) => ((t - base) / trackMs) * 100
/** The track's translateX in percent of its own width at time `now`, for a track built at `now0`. */
export const slidePct = (now, now0, trackMs) => -((now - now0) / trackMs) * 100
/** Where the NOW marker sits in the visible window (percent of the lane view's width). */
export const NOW_PCT = PAST_FRAC * 100
/** The clock the slide follows: whole minutes under reduced motion (no smooth slide), the real time otherwise. */
export const slideClock = (now, reduced) => (reduced ? Math.floor(now / 60000) * 60000 : now)

/**
 * Thin a sorted list of run times so no two kept ticks are closer than `minGapMs` (the first, which is the next
 * run, is always kept). Returns the kept times.
 */
export function cullTicks(runs, minGapMs) {
  const out = []
  let last = -Infinity
  for (const t of runs) {
    if (t - last < minGapMs) continue
    out.push(t)
    last = t
  }
  return out
}
/** The smallest gap between ticks that stays legible: `minPx` of a view `viewPx` wide showing `span` ms. */
export const minGap = (span, viewPx, minPx = 5) => (span / Math.max(1, viewPx)) * minPx

/** First run strictly after `now` from a lane's runs plus the server's `next`, or null. */
export function nextAfter(now, runs, next) {
  for (const t of runs) if (t > now) return t
  return next != null && next > now ? next : null
}

/** "in 42s", "in 12m", "in 2h 05m", "in 3d 4h". */
export function countdown(ms) {
  if (!(ms > 0)) return 'now'
  const s = Math.round(ms / 1000)
  if (s < 90) return `in ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h ${String(m % 60).padStart(2, '0')}m`
  return `in ${Math.floor(h / 24)}d ${h % 24}h`
}
export const isSoon = (ms) => ms > 0 && ms <= SOON_MS

const DAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const pad = (n) => String(n).padStart(2, '0')
function label(t, daily) {
  const d = new Date(t)
  if (daily || (d.getHours() === 0 && d.getMinutes() === 0)) return `${DAY[d.getDay()]} ${d.getDate()}`
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const STEP_MIN = { '3h': 30, '12h': 60, '24h': 60 }

/**
 * Time labels for the axis across the track [base, base + trackMs]: { t, text, major }[] at local clock times
 * (every 30 min, 1 h, or 3 h on the 24h zoom; local midnights for 7d). Walks the calendar, so DST never skews a label.
 */
export function axisMarks(base, trackMs, zoomId) {
  const out = []
  const end = base + trackMs
  if (zoomId === '7d') {
    for (let d = new Date(new Date(base).getFullYear(), new Date(base).getMonth(), new Date(base).getDate() + 1); d.getTime() <= end && out.length < 20; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      out.push({ t: d.getTime(), text: label(d.getTime(), true), major: true })
    }
    return out
  }
  const step = STEP_MIN[zoomId] || 60
  const s = new Date(base)
  // Align to the step on the local clock, then walk in step-minute increments.
  let t = new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), 0).getTime()
  while (t <= base) t += step * 60000
  for (; t <= end && out.length < 100; t += step * 60000) {
    const d = new Date(t)
    if (zoomId === '24h' && d.getHours() % 3) continue
    out.push({ t, text: label(t, false), major: d.getMinutes() === 0 })
  }
  return out
}

/** How many lanes of `laneH` px (gap included) fit in `avail` px: at least 1. */
export const lanesPerPage = (avail, laneH) => fitCount(avail, laneH)
/** The [start, end) lane indexes of page `page`. */
export const lanePage = (total, per, page) => {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, per)))
  const p = Math.min(Math.max(0, page), pages - 1)
  return { pages, page: p, start: p * per, end: Math.min(total, (p + 1) * per) }
}
