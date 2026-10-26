import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { wakeTime, isWakeReady, lifecycleOf, annotateRows, visibleRows, hideDone } from '../lib/lifecycle.mjs'
import { readState, parkSession, unparkSession, setDone, setOverlay } from '../lib/state.mjs'

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const tmp = async () => path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-')), 'state.json')
const NOW = new Date(2026, 9, 26, 12).getTime()

test('wakeTime accepts real calendar dates only', () => {
  assert.equal(wakeTime('2026-10-26'), new Date(2026, 9, 26).getTime())
  for (const bad of ['2026-02-30', '26-10-2026', '', null, '2026-13-01']) assert.ok(Number.isNaN(wakeTime(bad)), String(bad))
})

test('a date wake is ready on and after its day; none never is', () => {
  const p = (wake) => ({ reason: 'x', wake })
  assert.equal(isWakeReady(p({ type: 'date', value: '2026-10-26' }), NOW), true)
  assert.equal(isWakeReady(p({ type: 'date', value: '2026-10-27' }), NOW), false)
  assert.equal(isWakeReady(p({ type: 'none', value: '' }), NOW), false)
  assert.equal(isWakeReady(null, NOW), false)
})

test('park / unpark / done round-trip through state.json and keep other state', async () => {
  const file = await tmp()
  await setOverlay(id(1), 'Mine', file)
  await parkSession(id(1), { reason: '  waiting on\nreview ', wake: { type: 'date', value: '2026-11-01' }, handoffNote: ' next: merge ' }, file, 5)
  let s = await readState(file)
  assert.deepEqual(s.parked[id(1)], { parkedAt: 5, parkedBy: '', reason: 'waiting on review', wake: { type: 'date', value: '2026-11-01' }, handoffNote: 'next: merge' })
  assert.equal(s.overlays[id(1)].name, 'Mine')
  await setDone(id(1), true, file)
  s = await readState(file)
  assert.equal(s.done[id(1)], true)
  assert.equal(s.parked[id(1)], undefined, 'done un-parks')
  await parkSession(id(1), { reason: 'again' }, file)
  s = await readState(file)
  assert.equal(s.done[id(1)], undefined, 'parking un-dones')
  assert.equal(s.parked[id(1)].wake, null)
  await unparkSession(id(1), file)
  assert.deepEqual((await readState(file)).parked, {})
})

test('validation: bad ids, empty reason, bad wake', async () => {
  const file = await tmp()
  await assert.rejects(parkSession('../x', { reason: 'r' }, file), /bad session id/)
  await assert.rejects(parkSession(id(1), { reason: ' ' }, file), /reason/)
  await assert.rejects(parkSession(id(1), { reason: 'r', wake: { type: 'ticket' } }, file), /wake type/)
  await assert.rejects(parkSession(id(1), { reason: 'r', wake: { type: 'date', value: 'soon' } }, file), /YYYY-MM-DD/)
  await assert.rejects(setDone('bad', true, file), /bad session id/)
  await assert.rejects(unparkSession('bad', file), /bad session id/)
  await assert.rejects(fsp.stat(file), 'nothing written on failure')
})

test('readState defaults parked and done on an old state file', async () => {
  const file = await tmp()
  await fsp.writeFile(file, JSON.stringify({ overlays: { a: 1 } }))
  const s = await readState(file)
  assert.deepEqual([s.parked, s.done], [{}, {}])
})

test('queue filter: parked leave unless blocked or wake-ready; done always hidden', () => {
  const rows = [
    { sessionId: id(1), state: 'blocked' },
    { sessionId: id(2), state: 'blocked' },
    { sessionId: id(3), state: 'working' },
    { sessionId: id(4), state: 'idle' },
    { sessionId: id(5), state: 'idle' },
    { sessionId: id(6), state: 'blocked' },
  ]
  const state = {
    parked: {
      [id(2)]: { reason: 'r', wake: null },
      [id(3)]: { reason: 'r', wake: null },
      [id(4)]: { reason: 'r', wake: { type: 'date', value: '2026-10-01' } },
    },
    done: { [id(5)]: true, [id(6)]: true },
  }
  const ann = annotateRows(rows, state, NOW)
  assert.equal(ann[3].wakeReady, true)
  assert.deepEqual(visibleRows(ann).map((r) => r.sessionId), [id(1), id(2), id(4)])
  assert.equal(visibleRows(ann)[1].parked.reason, 'r', 'blocked parked row stays, marked')
})

test('hideDone prunes done nodes, children included', () => {
  const n = (i, done = false) => ({ sessionId: id(i), done })
  const t = hideDone({ interface: [n(1)], managers: [{ ...n(2), children: [n(3), n(4, true)] }, { ...n(5, true), children: [n(6)] }], orphans: [n(7, true)], unclassified: [n(8)] })
  assert.deepEqual(t.managers.map((m) => [m.sessionId, m.children.map((c) => c.sessionId)]), [[id(2), [id(3)]]])
  assert.deepEqual([t.orphans.length, t.unclassified.length], [0, 1])
})

test('lifecycleOf names the parking manager; a bad parkedBy is refused', async () => {
  const state = { parked: { [id(1)]: { parkedAt: 1, parkedBy: id(2), reason: 'r', wake: null }, [id(3)]: { parkedAt: 1, parkedBy: '', reason: 'r', wake: null } }, done: {} }
  const nameOf = (x) => (x === id(2) ? 'Auth manager' : '')
  assert.equal(lifecycleOf(state, id(1), NOW, nameOf).parked.parkedByName, 'Auth manager')
  assert.equal(lifecycleOf(state, id(3), NOW, nameOf).parked.parkedByName, '')
  assert.equal(lifecycleOf(state, id(4), NOW, nameOf).parked, null)
  await assert.rejects(parkSession(id(1), { reason: 'r', parkedBy: '../x' }, await tmp()), /parkedBy/)
})
