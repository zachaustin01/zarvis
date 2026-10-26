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

test('an impossible calendar date never rolls over: rejected by the shared validation', async () => {
  const file = await tmp()
  for (const value of ['2026-02-31', '2026-04-31', '2027-02-29']) {
    await assert.rejects(parkSession(id(1), { reason: 'r', wake: { type: 'date', value } }, file), /YYYY-MM-DD/, value)
  }
  await parkSession(id(1), { reason: 'r', wake: { type: 'date', value: '2028-02-29' } }, file)
})

import { archivedParked } from '../lib/lifecycle.mjs'
import { renderRoster } from '../lib/roster.mjs'

test('archivedParked lists parked sessions whose only desktop record is archived', () => {
  const rec = (n, extra = {}) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `S${n}`, cwd: `/r/proj${n}`, branch: 'main', ...extra })
  const records = [
    rec(1, { isArchived: true }), // parked + archived: listed
    rec(2, { isArchived: 'True' }), // parked + archived, a worker of manager 9: listed under it
    rec(3, { isArchived: true }), // archived, not parked: not listed
    rec(4, { isArchived: true }), // parked but done: not listed
    rec(5), // parked, live record: a normal tree node, not listed here
    rec(6, { isArchived: true }), rec(6), // twin: a live record exists, so not listed
    { sessionId: 'local_x', title: 'no cli id', isArchived: true },
  ]
  const parked = (n) => ({ reason: `r${n}`, parkedAt: 1, wake: null, handoffNote: '' })
  const state = { parked: { [id(1)]: parked(1), [id(2)]: parked(2), [id(4)]: parked(4), [id(5)]: parked(5), [id(6)]: parked(6), [id(7)]: parked(7) }, done: { [id(4)]: true } } // 7 has no record at all
  const roles = { [id(2)]: { role: 'worker', parent: id(9) } }
  const got = archivedParked(records, state, roles)
  assert.deepEqual(got.map((n) => [n.sessionId, n.role, n.managerId, n.archived]), [[id(1), 'unclassified', '', true], [id(2), 'worker', id(9), true]])
  assert.equal(got[0].title, 'S1')
  assert.equal(got[0].cwd, '/r/proj1')
})

test('hideDone keeps archived parked sessions apart from done ones; the roster lists archived workers under their manager, marked', () => {
  const n = (x, extra = {}) => ({ sessionId: id(x), name: `N${x}`, state: 'unknown', project: 'p', branch: '', desktopSessionId: '', ...extra })
  const park = { reason: 'finished', parkedAt: 0, wake: null, handoffNote: '' }
  const tree = { interface: [], managers: [{ ...n(1), children: [] }], orphans: [], unclassified: [], archived: [n(2, { parked: park, managerId: id(1), archived: true }), n(3, { parked: park, managerId: id(1), archived: true, done: true })] }
  const kept = hideDone(tree)
  assert.deepEqual(kept.archived.map((a) => a.sessionId), [id(2)])
  const text = renderRoster(kept)
  assert.match(text, /N2 — parked \(archived in the app\) — finished/)
  assert.doesNotMatch(text, /N3/)
  assert.match(text, /workers: none live/)
})
