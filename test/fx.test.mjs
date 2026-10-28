import test from 'node:test'
import assert from 'node:assert/strict'
import { needsYou, fuseVars, glowState } from '../public/fx.js'

const MIN = 60_000
const OD = 5 * MIN
const blocked = (since, extra = {}) => ({ state: 'blocked', since, ...extra })

test('fuseVars: elapsed fraction and the negative delay that resumes the animation mid-way', () => {
  assert.deepEqual(fuseVars(1000, 1000, OD), { p: 0, d: '-0.0s' })
  assert.deepEqual(fuseVars(0, OD / 2, OD), { p: 0.5, d: '-150.0s' })
  assert.deepEqual(fuseVars(0, 99 * MIN, OD), { p: 1, d: '-300.0s' }) // clamped at overdue
  assert.deepEqual(fuseVars(10_000, 5_000, OD), { p: 0, d: '-0.0s' }) // a clock a little behind the server
})

test('needsYou counts blocked permission and question rows, not parked or working ones', () => {
  assert.equal(needsYou(blocked(0)), true)
  assert.equal(needsYou(blocked(0, { kind: 'question' })), true)
  assert.equal(needsYou(blocked(0, { parked: {} })), false)
  assert.equal(needsYou({ state: 'working' }), false)
})

test('glowState: nothing, amber while blocked, red once any wait is overdue', () => {
  const now = 10 * MIN
  assert.equal(glowState([], now, OD), '')
  assert.equal(glowState([{ state: 'working' }, blocked(0, { parked: {} })], now, OD), '')
  assert.equal(glowState([blocked(now - MIN), { state: 'idle' }], now, OD), 'blocked')
  assert.equal(glowState([blocked(now - MIN), blocked(now - 6 * MIN, { kind: 'question' })], now, OD), 'overdue')
})

import { attention, tabTitle, faviconState } from '../public/fx.js'

test('attention counts unparked blocked rows and flags overdue ones', () => {
  const now = 10 * MIN
  assert.deepEqual(attention([], now, OD), { count: 0, overdue: false })
  assert.deepEqual(attention([blocked(now - MIN), blocked(now - 2 * MIN, { parked: {} }), { state: 'working', since: 0 }], now, OD), { count: 1, overdue: false })
  assert.deepEqual(attention([blocked(now - MIN), blocked(now - 6 * MIN, { kind: 'question' })], now, OD), { count: 2, overdue: true })
})

test('tabTitle: plain when idle, count in parentheses, ! when overdue', () => {
  assert.equal(tabTitle({ count: 0, overdue: false }), 'Zarvis')
  assert.equal(tabTitle({ count: 0, overdue: true }), 'Zarvis') // nothing blocked, nothing to flag
  assert.equal(tabTitle({ count: 3, overdue: false }), '(3) Zarvis')
  assert.equal(tabTitle({ count: 3, overdue: true }), '(3!) Zarvis')
})

test('faviconState: the key flips only when the picture would', () => {
  assert.equal(faviconState({ count: 0, overdue: false }).key, 'idle:')
  assert.equal(faviconState({ count: 2, overdue: false }).key, 'amber:2')
  assert.equal(faviconState({ count: 2, overdue: true }).key, 'red:2')
  assert.equal(faviconState({ count: 12, overdue: false }).label, '9+')
  assert.equal(faviconState({ count: 2, overdue: false }).key, faviconState({ count: 2, overdue: false }).key)
})

import { snapshot, diffEvents } from '../public/fx.js'

const row = (id, state, extra = {}) => ({ sessionId: id, name: id, state, since: 0, ...extra })

test('diffEvents: nothing on the first load, then arrived / blocked / resumed / finished / parked', () => {
  assert.deepEqual(diffEvents(null, [row('a', 'blocked')]), [])
  const prev = snapshot([row('a', 'working'), row('b', 'blocked'), row('c', 'working'), row('d', 'idle'), row('e', 'blocked')])
  const next = [row('a', 'blocked', { tool: 'Bash' }), row('b', 'working'), row('c', 'idle'), row('d', 'idle', { parked: {} }), row('e', 'blocked', { parked: {} }), row('f', 'working')]
  assert.deepEqual(diffEvents(prev, next).map((e) => [e.id, e.kind, e.text]), [
    ['a', 'blocked', 'a needs you · Bash'],
    ['b', 'resumed', 'b resumed'],
    ['c', 'finished', 'c finished'],
    ['d', 'parked', 'd parked'],
    ['e', 'parked', 'e parked'],
    ['f', 'arrived', 'f appeared'],
  ])
})

test('diffEvents: a question is a blocked event, a blocked row that goes idle finished, no repeats when nothing changed', () => {
  const prev = snapshot([row('q', 'working'), row('b', 'blocked')])
  assert.equal(diffEvents(prev, [row('q', 'blocked', { kind: 'question' }), row('b', 'idle')]).map((e) => e.text).join('|'), 'q asks a question|b finished')
  assert.deepEqual(diffEvents(snapshot([row('x', 'blocked')]), [row('x', 'blocked')]), [])
  assert.deepEqual(diffEvents(snapshot([row('x', 'blocked', { parked: {} })]), [row('x', 'blocked', { parked: {} })]), [])
})

import { mergeTicker, evKey, evKindClass, safeUrl, evTime, TICKER_MAX } from '../public/fx.js'

const pe = (at, text, extra = {}) => ({ at, kind: 'push', text, pushed: true, ...extra })

test('mergeTicker: newest first by time, pushed and transitions interleaved', () => {
  const a = mergeTicker([], [pe(1, 'a'), pe(3, 'c')])
  const b = mergeTicker(a.items, [{ at: 2, kind: 'blocked', text: 'b', key: 't2' }])
  assert.deepEqual(b.items.map((e) => e.text), ['c', 'b', 'a'])
  assert.deepEqual(b.added.map((e) => e.text), ['b'])
})

test('mergeTicker: de-dupes on (at, sessionId, text), also across repeated payloads', () => {
  const first = mergeTicker([], [pe(1, 'a', { sessionId: 's' })])
  const again = mergeTicker(first.items, [pe(1, 'a', { sessionId: 's' }), pe(1, 'a', { sessionId: 't' })])
  assert.equal(again.items.length, 2)
  assert.deepEqual(again.added.map((e) => e.sessionId), ['t'])
  assert.equal(evKey({ at: 1, text: 'a' }), '1||a')
})

test('mergeTicker: keeps at most `max` (12 here; 40 by default), dropping the oldest; an evicted old event is not "added"', () => {
  const many = Array.from({ length: 20 }, (_, i) => pe(100 + i, `e${i}`))
  const r = mergeTicker([], many, 12)
  assert.equal(TICKER_MAX, 40)
  assert.equal(r.items.length, 12)
  assert.equal(r.items[0].text, 'e19')
  assert.equal(r.items.at(-1).text, 'e8')
  assert.equal(r.added.length, 12)
  const old = mergeTicker(r.items, [pe(1, 'ancient')], 12)
  assert.deepEqual(old.added, [])
  assert.equal(old.items.length, 12)
})

test('evKindClass, safeUrl and evTime', () => {
  assert.equal(evKindClass('push'), 'push')
  assert.equal(evKindClass('my-kind'), 'other')
  assert.equal(evKindClass('"><x'), 'other')
  assert.equal(safeUrl('https://a.example/x?y=1'), 'https://a.example/x?y=1')
  for (const u of ['javascript:alert(1)', 'data:text/html,x', '', undefined, 'https://a b', `https://h/${'a'.repeat(300)}`]) assert.equal(safeUrl(u), '')
  const now = Date.now()
  assert.match(evTime(now, now), /^\d\d:\d\d:\d\d$/)
  assert.match(evTime(now - 3 * 86400000, now), /^\d\d-\d\d \d\d:\d\d:\d\d$/)
})

test('XSS: the ticker renders event text only through textContent / properties, never innerHTML', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = src.indexOf('function eventEl')
  const body = src.slice(start, src.indexOf('function paintCount', start))
  assert.ok(body.includes('textContent') && !/innerHTML|insertAdjacentHTML/.test(body))
})

import { evParts, evImportant, evDay, evClock, groupByDay, TICKER_SLIDE_MS } from '../public/fx.js'

test('evParts splits what happened from the dimmed detail after the first ": "', () => {
  assert.deepEqual(evParts('finished a background command: npm run build: ok'), { head: 'finished a background command', detail: 'npm run build: ok' })
  assert.deepEqual(evParts('needs you · Bash'), { head: 'needs you · Bash', detail: '' })
  assert.deepEqual(evParts('ends with: '), { head: 'ends with: ', detail: '' })
  assert.deepEqual(evParts(undefined), { head: '', detail: '' })
})

test('evImportant: warnings, finished workers and sessions that need you draw the eye', () => {
  for (const kind of ['warn', 'done', 'blocked', 'finished']) assert.equal(evImportant({ kind }), true, kind)
  for (const kind of ['info', 'push', 'pr', 'parked', 'arrived', 'resumed']) assert.equal(evImportant({ kind }), false, kind)
})

test('groupByDay: newest-first entries grouped under Today / Yesterday / a date, clock without seconds', () => {
  const now = new Date(2026, 9, 28, 15, 0, 0).getTime()
  const at = (d, h, m) => new Date(2026, 9, d, h, m, 5).getTime()
  const items = [{ at: at(28, 14, 5) }, { at: at(28, 9, 30) }, { at: at(27, 22, 1) }, { at: at(20, 8, 0) }]
  const g = groupByDay(items, now)
  assert.deepEqual(g.map((x) => [x.label === 'Today' || x.label === 'Yesterday' ? x.label : 'date', x.items.length]), [['Today', 2], ['Yesterday', 1], ['date', 1]])
  assert.equal(evDay(at(20, 8, 0), now), g[2].label)
  assert.equal(evClock(at(28, 9, 3)), '09:03')
  assert.deepEqual(groupByDay([], now), [])
  assert.equal(TICKER_SLIDE_MS > 0, true)
})

test('diffEvents: an interface row flipping between no signal and live is not news; a real block still is', () => {
  const prev = snapshot([row('i', 'unknown')])
  assert.deepEqual(diffEvents(prev, [row('i', 'working')]), []) // process started
  assert.deepEqual(diffEvents(snapshot([row('i', 'working')]), [row('i', 'unknown')]), []) // process shut down
  assert.deepEqual(diffEvents(snapshot([row('i', 'idle')]), [row('i', 'unknown')]), [])
  assert.deepEqual(diffEvents(prev, [row('i', 'blocked', { tool: 'Bash' })]).map((e) => e.kind), ['blocked'])
})

import { reactorCounts, reactorArcs, reactorState, reactorText, REACTOR_C } from '../public/fx.js'

test('reactorCounts: blocked matches needsYou, parked rows are not blocked, no-signal rows count nowhere', () => {
  const rs = [
    { state: 'blocked' }, { state: 'blocked', kind: 'question' }, // needs you
    { state: 'blocked', parked: {} }, { state: 'idle', parked: {} }, // parked, even though one is blocked
    { state: 'working' }, { state: 'waiting_on_child' },
    { state: 'idle' }, { state: 'unknown' },
  ]
  assert.deepEqual(reactorCounts(rs), { blocked: 2, working: 2, idle: 1, parked: 2 })
  assert.equal(reactorCounts(rs).blocked, rs.filter(needsYou).length)
  assert.deepEqual(reactorCounts([]), { blocked: 0, working: 0, idle: 0, parked: 0 })
  assert.equal(reactorCounts(rs, 7).parked, 7) // the tree's real parked total wins
  assert.equal(reactorCounts(rs, 0).parked, 0)
})

test('reactorArcs: shares of the ring end to end from the top, a gap only between several arcs, empty when nothing', () => {
  const C = REACTOR_C
  const none = reactorArcs({ blocked: 0, working: 0, idle: 0, parked: 0 })
  assert.deepEqual(none.map((a) => a.frac), [0, 0, 0, 0])
  assert.ok(none.every((a) => a.dash.startsWith('0.00 ')))
  const one = reactorArcs({ blocked: 0, working: 3, idle: 0, parked: 0 })
  assert.equal(one[1].frac, 1)
  assert.equal(Number(one[1].dash.split(' ')[0]), Number(C.toFixed(2))) // a lone arc fills the ring, no gap
  const mix = reactorArcs({ blocked: 1, working: 1, idle: 2, parked: 0 })
  assert.deepEqual(mix.map((a) => a.frac), [0.25, 0.25, 0.5, 0])
  assert.equal(mix[0].offset, '0.00')
  assert.equal(Number(mix[1].offset), -Number((C * 0.25).toFixed(2)))
  assert.equal(Number(mix[2].offset), -Number((C * 0.5).toFixed(2)))
  const len = (a) => Number(a.dash.split(' ')[0])
  assert.ok(Math.abs(mix.reduce((s, a) => s + len(a), 0) - (C - 3 * 1.2)) < 0.05) // three arcs, three gaps
})

test('reactorState and reactorText: calm, amber, red, and the spin only while working', () => {
  const zero = { blocked: 0, working: 0, idle: 0, parked: 0 }
  assert.deepEqual(reactorState(zero, { count: 0, overdue: false }), { core: '', spin: false })
  assert.deepEqual(reactorState({ ...zero, blocked: 1 }, { count: 1, overdue: false }), { core: 'amber', spin: false })
  assert.deepEqual(reactorState({ ...zero, blocked: 1, working: 2 }, { count: 1, overdue: true }), { core: 'red', spin: true })
  assert.equal(reactorText(zero), 'calm')
  assert.equal(reactorText({ ...zero, blocked: 2, working: 3 }), '2 need · 3 run')
  assert.equal(reactorText({ ...zero, working: 1 }), '1 run')
})

import { dialDash, compactWait, waitDial, hookDial, projectGauges, DIAL_C } from '../public/fx.js'

test('compactWait and dialDash', () => {
  assert.equal(compactWait(0), '0s')
  assert.equal(compactWait(42_000), '42s')
  assert.equal(compactWait(7 * 60_000 + 5_000), '7m')
  assert.equal(compactWait(3 * 3600_000), '3h')
  assert.equal(dialDash(0), `0.00 ${DIAL_C.toFixed(2)}`)
  assert.equal(dialDash(2), dialDash(1)) // clamped
  assert.equal(dialDash(-1), dialDash(0))
})

test('waitDial: the oldest unparked blocked wait as a share of the overdue window', () => {
  const now = 10 * MIN
  assert.deepEqual(waitDial([{ state: 'working' }, blocked(0, { parked: {} })], now, OD), { p: 0, text: '—', state: '', count: 0 })
  const w = waitDial([blocked(now - MIN), blocked(now - 2 * MIN)], now, OD)
  assert.equal(w.text, '2m')
  assert.equal(w.p, 0.4)
  assert.equal(w.state, 'amber')
  assert.equal(w.count, 2)
  const late = waitDial([blocked(now - 8 * MIN, { kind: 'question' })], now, OD)
  assert.deepEqual([late.p, late.state, late.text], [1, 'red', '8m'])
})

test('hookDial maps the server status and never guesses', () => {
  assert.deepEqual(hookDial('live'), { p: 1, state: 'live' })
  assert.deepEqual(hookDial('stale'), { p: 0.5, state: 'stale' })
  assert.deepEqual(hookDial('absent'), { p: 0, state: 'absent' })
  assert.deepEqual(hookDial(undefined), { p: 0, state: 'unknown' })
})

test('projectGauges: per-project mix of live projects, parked from the tree, no interface, blocked first', () => {
  const r = (project, state, extra = {}) => ({ project, state, since: 0, role: 'worker', ...extra })
  const rows = [r('a', 'working'), r('b', 'blocked'), r('b', 'idle'), r('a', 'idle'), r('x', 'working', { role: 'interface' })]
  const nodes = [r('a', 'unknown', { parked: {} }), r('c', 'unknown', { parked: {} }), r('c', 'unknown', { parked: {}, done: true }), r('x', 'unknown', { role: 'interface', parked: {} })]
  const g = projectGauges(rows, nodes)
  assert.deepEqual(g.map((x) => x.project), ['b', 'a']) // blocked first, then working, then name; parked-only 'c' has no gauge
  assert.deepEqual(g[1].counts, { blocked: 0, working: 1, idle: 1, parked: 1 }) // a live project still counts its parked session
  assert.equal(g[0].total, 2)
  assert.equal(g[0].arcs.length, 4)
})

import { ifaceRing, loopDelay, IFACE_C } from '../public/fx.js'

test('ifaceRing: honest state and label for the interface ring; a blocked wait fills toward overdue', () => {
  const now = 10 * MIN
  assert.deepEqual(ifaceRing({ state: 'working', since: 0 }, now, OD), { state: 'working', label: 'working', p: 0, od: false })
  assert.equal(ifaceRing({ state: 'idle' }, now, OD).label, 'idle')
  assert.deepEqual(ifaceRing({ state: 'unknown' }, now, OD), { state: 'off', label: 'no signal', p: 0, od: false }) // never a guessed idle
  assert.equal(ifaceRing({ state: 'waiting_on_child' }, now, OD).state, 'child')
  assert.deepEqual(ifaceRing({ state: 'blocked', since: now - 2.5 * MIN }, now, OD), { state: 'blocked', label: 'needs you', p: 0.5, od: false })
  const late = ifaceRing({ state: 'blocked', kind: 'question', since: now - 9 * MIN }, now, OD)
  assert.deepEqual([late.label, late.p, late.od], ['asks a question', 1, true])
  assert.ok(IFACE_C > 550 && IFACE_C < 560)
})

test('loopDelay keeps a looping animation continuous: the same instant gives the same phase', () => {
  assert.equal(loopDelay(30_000, 30_000), '-0s')
  assert.equal(loopDelay(37_500, 30_000), '-7.5s')
  assert.equal(loopDelay(67_500, 30_000), loopDelay(37_500, 30_000))
})

test('projectGauges: a project whose only sessions are parked or archived has no gauge; a started session brings it back', () => {
  const r = (project, state, extra = {}) => ({ project, state, since: 0, role: 'worker', ...extra })
  const parkedOnly = [r('scratch', 'unknown', { parked: {} }), r('scratch', 'unknown', { parked: {}, archived: true })]
  assert.deepEqual(projectGauges([], parkedOnly), [])
  assert.deepEqual(projectGauges([r('scratch', 'idle', { parked: {} })], parkedOnly), []) // a parked row (wake-ready, blocked-parked) keeps nothing alive either
  const back = projectGauges([r('scratch', 'working')], parkedOnly)
  assert.deepEqual(back.map((g) => [g.project, g.counts]), [['scratch', { blocked: 0, working: 1, idle: 0, parked: 2 }]]) // parked count includes the archived one
  const live = projectGauges([], [r('scratch', 'idle'), ...parkedOnly])
  assert.deepEqual(live.map((g) => g.project), ['scratch']) // a live tree node with a hook signal also counts
})

import { clockText, pushSample, sparkPoints, SPARK_MAX } from '../public/fx.js'

test('clockText is HH:MM:SS', () => {
  assert.match(clockText(Date.now()), /^\d\d:\d\d:\d\d$/)
  assert.equal(clockText(new Date(2026, 9, 26, 7, 5, 9).getTime()), '07:05:09')
})

test('pushSample keeps the newest SPARK_MAX; sparkPoints scales to the peak, newest at the right', () => {
  let s = []
  for (let i = 0; i < SPARK_MAX + 5; i++) s = pushSample(s, i % 3)
  assert.equal(s.length, SPARK_MAX)
  assert.equal(sparkPoints([], 64, 18), '1,17 63,17') // baseline only
  assert.equal(sparkPoints([0], 64, 18), '1,17 63,17')
  assert.equal(sparkPoints([0, 0, 0], 64, 18), '1.0,17.0 32.0,17.0 63.0,17.0') // flat zero sits on the baseline
  assert.equal(sparkPoints([0, 2, 1], 64, 18), '1.0,17.0 32.0,1.0 63.0,9.0') // peak at the top, last sample at the right edge
})

import { paginate, clampPage, pageOfIndex, firstRowOn, pageFlags, flagElsewhere, wheelFlip, pageLabel, fitCount, windowAround } from '../public/fx.js'

test('paginate: greedy by measured heights, a heading never ends a page, every page has an item', () => {
  assert.deepEqual(paginate([], [], 500), [[0, 0]])
  assert.deepEqual(paginate([100, 100, 100], [false, false, false], 1000), [[0, 3]])
  assert.deepEqual(paginate([100, 100, 100, 100], [false, false, false, false], 250), [[0, 2], [2, 4]])
  // variable heights: 40 + 300 + 60 + 60 on a 380 window
  assert.deepEqual(paginate([40, 300, 60, 60], [false, false, false, false], 380), [[0, 2], [2, 4]])
  // a heading that would end the page moves to the next one
  assert.deepEqual(paginate([100, 100, 30, 100], [false, false, true, false], 240), [[0, 2], [2, 4]])
  // a row taller than the window still gets its own page; no avail at all pages one by one
  assert.deepEqual(paginate([900, 50], [false, false], 300), [[0, 1], [1, 2]])
  assert.deepEqual(paginate([10, 10, 10], [false, false, false], 0), [[0, 1], [1, 2], [2, 3]])
  // a lone heading cannot be moved (it would leave an empty page)
  assert.deepEqual(paginate([30, 100], [true, false], 40), [[0, 1], [1, 2]])
})

test('clamp, page of an index, first row of a page', () => {
  const pages = [[0, 3], [3, 5], [5, 8]]
  const heads = [true, false, false, true, false, false, false, false]
  assert.equal(clampPage(9, 3), 2)
  assert.equal(clampPage(-2, 3), 0)
  assert.equal(clampPage(1, 0), 0)
  assert.equal(pageOfIndex(pages, 0), 0)
  assert.equal(pageOfIndex(pages, 4), 1)
  assert.equal(pageOfIndex(pages, 7), 2)
  assert.equal(pageOfIndex(pages, 8), -1)
  assert.equal(firstRowOn(pages, heads, 0), 1) // skips the heading
  assert.equal(firstRowOn(pages, heads, 1), 4)
  assert.equal(firstRowOn(pages, [true, true, true, true, true, true, true, true], 1), -1)
})

test('the pager signals needs-you rows on other pages, red beating amber, never the current page', () => {
  const pages = [[0, 2], [2, 4], [4, 6]]
  const per = pageFlags(pages, ['', 'amber', '', '', 'red', ''])
  assert.deepEqual(per, ['amber', '', 'red'])
  assert.equal(flagElsewhere(per, 0), 'red')
  assert.equal(flagElsewhere(per, 2), 'amber')
  assert.equal(flagElsewhere(per, 1), 'red')
  assert.equal(flagElsewhere(['red', ''], 0), '') // the blocked row is on the page you are looking at
  assert.equal(flagElsewhere([''], 0), '')
})

test('wheelFlip: past the threshold, once per cooldown, vertical or horizontal', () => {
  assert.equal(wheelFlip({ dy: 10, now: 1000 }), 0)
  assert.equal(wheelFlip({ dy: 80, now: 1000 }), 1)
  assert.equal(wheelFlip({ dy: -80, now: 1000 }), -1)
  assert.equal(wheelFlip({ dx: 90, dy: 5, now: 1000 }), 1)
  assert.equal(wheelFlip({ dy: 80, now: 1100, lastFlipAt: 1000 }), 0) // momentum tail of the same swipe
  assert.equal(wheelFlip({ dy: 80, now: 1500, lastFlipAt: 1000 }), 1)
})

test('pageLabel, fitCount and windowAround', () => {
  assert.equal(pageLabel(1, 4), 'PAGE 2/4')
  assert.equal(fitCount(300, 40), 7)
  assert.equal(fitCount(10, 40), 1)
  assert.deepEqual(windowAround(0, 20, 5), [0, 5])
  assert.deepEqual(windowAround(10, 20, 5), [8, 13])
  assert.deepEqual(windowAround(19, 20, 5), [15, 20])
  assert.deepEqual(windowAround(2, 3, 5), [0, 3])
})
