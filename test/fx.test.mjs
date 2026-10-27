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
  const start = src.indexOf('function paintTicker')
  const body = src.slice(start, src.indexOf('function mergeInto', start))
  assert.ok(body.includes('textContent') && !/innerHTML|insertAdjacentHTML/.test(body))
})

import { scrollPlan, TICKER_PAUSE_MS, TICKER_SCROLL_MIN } from '../public/fx.js'

test('scrollPlan: static up to ten entries, when it fits, or with reduced motion; otherwise oldest-to-newest', () => {
  assert.equal(TICKER_SCROLL_MIN, 10)
  assert.equal(TICKER_PAUSE_MS, 5000)
  assert.deepEqual(scrollPlan({ count: 10, contentW: 5000, viewW: 800 }), { scroll: false, distance: 0, duration: 0 }) // ten: no scroll
  assert.equal(scrollPlan({ count: 11, contentW: 700, viewW: 800 }).scroll, false) // fits
  assert.equal(scrollPlan({ count: 30, contentW: 5000, viewW: 0 }).scroll, false) // not laid out yet
  assert.equal(scrollPlan({ count: 30, contentW: 5000, viewW: 800, reduced: true }).scroll, false)
  assert.deepEqual(scrollPlan({ count: 11, contentW: 1700, viewW: 800 }), { scroll: true, distance: 900, duration: 11250 }) // 80px/s
  assert.deepEqual(scrollPlan({ count: 40, contentW: 1700, viewW: 800, speed: 90 }), { scroll: true, distance: 900, duration: 10000 })
})

test('diffEvents: an interface row flipping between not running and live is not news; a real block still is', () => {
  const prev = snapshot([row('i', 'unknown')])
  assert.deepEqual(diffEvents(prev, [row('i', 'working')]), []) // process started
  assert.deepEqual(diffEvents(snapshot([row('i', 'working')]), [row('i', 'unknown')]), []) // process shut down
  assert.deepEqual(diffEvents(snapshot([row('i', 'idle')]), [row('i', 'unknown')]), [])
  assert.deepEqual(diffEvents(prev, [row('i', 'blocked', { tool: 'Bash' })]).map((e) => e.kind), ['blocked'])
})
