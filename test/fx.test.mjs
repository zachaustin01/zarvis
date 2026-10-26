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
