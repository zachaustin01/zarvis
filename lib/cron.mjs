// A small 5-field cron parser and next-run calculator (minute hour day-of-month month day-of-week), local time.
// Lists (1,15), ranges (1-5), steps (*/15, 10-30/5, 5/10), `*`, month and weekday names (jan, mon), 7 = Sunday.
// Day-of-month and day-of-week follow standard cron: when both are restricted a day matches if EITHER does; when
// either starts with `*` both must match. Runs are found by walking calendar days and building each candidate with
// the Date constructor, so DST never loops: a wall-clock time that does not exist that day (spring forward) is
// skipped, one that exists twice (fall back) runs once. The search is bounded; an impossible spec (Feb 31) gives [].

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
]
export const MAX_SPEC = 100
/** How far ahead a search looks: long enough for Feb 29 (up to eight years across a skipped century leap year). */
export const HORIZON_DAYS = 366 * 8

const bad = (msg) => Object.assign(new Error(msg), { refusal: true })

function value(tok, f) {
  if (f.names) {
    const i = f.names.indexOf(tok.toLowerCase())
    if (i >= 0) return i + f.base
  }
  if (!/^\d{1,2}$/.test(tok)) throw bad(`bad ${f.name} value "${tok}"`)
  const n = Number(tok)
  if (n < f.min || n > f.max) throw bad(`${f.name} ${n} is outside ${f.min}-${f.max}`)
  return n
}

function parseField(text, f) {
  const out = new Set()
  for (const part of text.split(',')) {
    if (!part) throw bad(`empty item in ${f.name}`)
    const [range, step, extra] = part.split('/')
    if (extra !== undefined) throw bad(`bad ${f.name} item "${part}"`)
    if (step !== undefined && !/^\d{1,2}$/.test(step)) throw bad(`bad step "${step}" in ${f.name}`)
    const n = step === undefined ? 1 : Number(step)
    if (n < 1) throw bad(`step must be at least 1 in ${f.name}`)
    let lo, hi
    if (range === '*') [lo, hi] = [f.min, f.name === 'day of week' ? 6 : f.max]
    else if (range.includes('-')) {
      const [a, b, more] = range.split('-')
      if (more !== undefined || !a || !b) throw bad(`bad range "${range}" in ${f.name}`)
      ;[lo, hi] = [value(a, f), value(b, f)]
      if (lo > hi) throw bad(`range "${range}" runs backwards in ${f.name}`)
    } else {
      lo = value(range, f)
      hi = step === undefined ? lo : f.name === 'day of week' ? 6 : f.max
    }
    for (let v = lo; v <= hi; v += n) out.add(f.name === 'day of week' ? v % 7 : v)
  }
  return out
}

/** Parse a 5-field spec. Throws an Error with `.refusal` and a readable message when it is not valid. */
export function parseCron(spec) {
  if (typeof spec !== 'string') throw bad('cron must be text')
  const s = spec.trim().replace(/\s+/g, ' ')
  if (!s || s.length > MAX_SPEC) throw bad(`cron must be 1-${MAX_SPEC} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad('cron has control characters')
  const parts = s.split(' ')
  if (parts.length !== 5) throw bad(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`)
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]))
  return { spec: s, minute: [...minute].sort((a, b) => a - b), hour: [...hour].sort((a, b) => a - b), dom, month, dow, domStar: parts[2].startsWith('*'), dowStar: parts[4].startsWith('*') }
}

/** The normalised spec, or '' when invalid. */
export function cleanCron(spec) {
  try {
    return parseCron(spec).spec
  } catch {
    return ''
  }
}

function dayMatches(c, d) {
  if (!c.month.has(d.getMonth() + 1)) return false
  const inDom = c.dom.has(d.getDate())
  const inDow = c.dow.has(d.getDay())
  return c.domStar || c.dowStar ? inDom && inDow : inDom || inDow
}

/**
 * Up to `count` run times (ms since epoch) strictly after `from`, no later than `until` (default: the horizon).
 * `spec` is a cron string or a parseCron result. Returns [] for a spec that never fires.
 */
export function nextRuns(spec, from = Date.now(), count = 5, until = from + HORIZON_DAYS * 86400000) {
  const c = typeof spec === 'string' ? parseCron(spec) : spec
  const out = []
  const limit = Math.min(Math.max(0, Math.floor(count)), 5000)
  if (!limit || !Number.isFinite(from) || !Number.isFinite(until)) return out
  const start = new Date(from)
  const last = Math.min(until, from + HORIZON_DAYS * 86400000)
  for (let day = 0; day <= HORIZON_DAYS + 2 && out.length < limit; day++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day)
    if (d.getTime() - 86400000 > last) break
    if (!dayMatches(c, d)) continue
    for (const h of c.hour) {
      for (const m of c.minute) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime()
        // A time inside a spring-forward gap rolls to another hour: skip it rather than run at the wrong time.
        const chk = new Date(t)
        if (chk.getHours() !== h || chk.getMinutes() !== m || chk.getDate() !== d.getDate()) continue
        if (t <= from) continue
        if (t > last) return out
        out.push(t)
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')
const hhmm = (h, m) => `${pad(h)}:${pad(m)}`
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Evenly spaced from 0 (or the field start) with this step: returns the step, else 0. */
function stepOf(list, size) {
  if (list.length < 2) return 0
  const s = list[1] - list[0]
  if (s < 2 || size % s !== 0 || list.length !== size / s) return 0
  return list.every((v, i) => v === list[0] + i * s) && list[0] < s ? s : 0
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`

function dowText(set) {
  const l = [...set].sort((a, b) => a - b)
  if (l.length === 5 && l.join() === '1,2,3,4,5') return 'weekdays'
  if (l.length === 2 && l.join() === '0,6') return 'weekends'
  if (l.length === 7) return 'daily'
  return `${l.length === 1 ? 'weekly ' : ''}${l.map((d) => WEEKDAY[d]).join(', ')}`
}

/** The spec in plain words ("hourly, on the hour", "weekdays 09:00"); falls back to the spec itself. Never throws. */
export function describeCron(spec) {
  let c
  try {
    c = typeof spec === 'string' ? parseCron(spec) : spec
  } catch {
    return String(spec ?? '')
  }
  const everyDay = c.dom.size === 31 && c.month.size === 12
  const allDow = c.dow.size === 7
  const mins = c.minute
  const hrs = c.hour
  const times = () => hrs.flatMap((h) => mins.map((m) => hhmm(h, m))).join(', ')
  if (!everyDay || !allDow) {
    if (c.month.size === 12 && !c.domStar && c.dowStar && hrs.length * mins.length <= 4) {
      const days = [...c.dom].sort((a, b) => a - b)
      return `monthly on the ${days.map(ordinal).join(', ')} ${times()}`
    }
    if (everyDay && c.month.size === 12 && hrs.length * mins.length <= 4) return `${dowText(c.dow) === 'daily' ? 'daily' : dowText(c.dow)} ${times()}`
    if (c.dow.size === 7 && c.dom.size === 31 && hrs.length * mins.length <= 4) return `${[...c.month].sort((a, b) => a - b).map((m) => MONTH_NAME[m - 1]).join(', ')}, daily ${times()}`
    return c.spec
  }
  // Every day from here on.
  const mStep = stepOf(mins, 60)
  const hAll = hrs.length === 24
  if (mins.length === 60 && hAll) return 'every minute'
  if (hAll && mStep) return `every ${mStep} minutes`
  if (hAll && mins.length === 1) return mins[0] === 0 ? 'hourly, on the hour' : `hourly, at :${pad(mins[0])}`
  const hStep = stepOf(hrs, 24)
  if (hStep && mins.length === 1) return `every ${hStep} hours${mins[0] ? `, at :${pad(mins[0])}` : ''}`
  if (hrs.length * mins.length <= 4) return `daily ${times()}`
  return c.spec
}
