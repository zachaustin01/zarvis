import test from 'node:test'
import assert from 'node:assert/strict'
import { projectsOf, filterRows, hiddenBlocked, filterTreeByProject, cycleProject, projectHue } from '../public/projects.js'

const row = (project, state, extra = {}) => ({ project, state, role: 'unclassified', ...extra })
const rows = [row('zarvis', 'blocked'), row('zarvis', 'working'), row('ais', 'blocked'), row('ais', 'blocked', { parked: {} }), row('ais', 'idle'), row('brain', 'working', { role: 'interface' })]

test('projectsOf counts unparked blocked and working per project, skipping the interface', () => {
  assert.deepEqual(projectsOf(rows, ['quiet']), [
    { project: 'ais', blocked: 1, working: 0, total: 3 },
    { project: 'quiet', blocked: 0, working: 0, total: 0 },
    { project: 'zarvis', blocked: 1, working: 1, total: 2 },
  ])
})

test('filterRows keeps the interface always; empty filter keeps all', () => {
  assert.equal(filterRows(rows, '').length, rows.length)
  assert.deepEqual(filterRows(rows, 'zarvis').map((r) => r.project), ['zarvis', 'zarvis', 'brain'])
})

test('hiddenBlocked counts only unparked blocked sessions outside the filter', () => {
  assert.equal(hiddenBlocked(rows, 'zarvis'), 1) // ais one; the parked one is not counted
  assert.equal(hiddenBlocked(rows, 'ais'), 1)
  assert.equal(hiddenBlocked(rows, ''), 0)
})

test('filterTreeByProject keeps the interface and managers with a matching worker', () => {
  const w = (project) => ({ project, role: 'worker' })
  const t = { interface: [{ project: 'brain' }], managers: [{ project: 'a', children: [w('b')] }, { project: 'c', children: [w('c')] }], orphans: [w('b'), w('a')], unclassified: [w('b')] }
  const f = filterTreeByProject(t, 'b')
  assert.equal(f.interface.length, 1)
  assert.deepEqual(f.managers.map((m) => m.project), ['a'])
  assert.equal(f.managers[0].children.length, 1)
  assert.equal(f.orphans.length, 1)
  assert.equal(filterTreeByProject(t, ''), t)
})

test('cycleProject goes All -> projects -> All and both ways; unknown means All', () => {
  assert.equal(cycleProject(['a', 'b'], ''), 'a')
  assert.equal(cycleProject(['a', 'b'], 'b'), '')
  assert.equal(cycleProject(['a', 'b'], '', -1), 'b')
  assert.equal(cycleProject(['a', 'b'], 'gone'), 'a')
  assert.equal(cycleProject([], ''), '')
})

test('projectHue is stable and in range', () => {
  assert.equal(projectHue('zarvis'), projectHue('zarvis'))
  assert.ok(projectHue('x') >= 0 && projectHue('x') < 360)
})

import { liveProjectNames, chipProjects, resolveProject, hiddenParked, ago } from '../public/projects.js'

test('chip set is the same before and after the tree loads, and a stale remembered project stays All', () => {
  const queue = [row('zarvis', 'blocked'), row('ais', 'working'), row('brain', 'working', { role: 'interface' })]
  // Sessions the hook never saw (state unknown) and an interface-only repo: no chips.
  const tree = [
    row('scratch-notes', 'unknown'),
    row('zarvis', 'unknown', { role: 'interface' }),
    row('zarvis', 'blocked'),
    row('ais', 'working'),
  ]
  const before = chipProjects(queue, [])
  const after = chipProjects(queue, tree)
  assert.deepEqual(before.map((c) => c.project), ['ais', 'zarvis'])
  assert.deepEqual(after.map((c) => c.project), ['ais', 'zarvis'])
  // The repro: 'scratch-notes' remembered, no chip: All before and after the tree is opened.
  assert.equal(resolveProject('scratch-notes', before), '')
  assert.equal(resolveProject('scratch-notes', after), '')
  assert.equal(resolveProject('zarvis', after), 'zarvis')
  assert.equal(resolveProject('', after), '')
})

test('a project with only parked or archived sessions has no chip; a live one keeps it; a remembered filter on it resets', () => {
  const P = { reason: 'x' }
  const parkedOnly = [row('scratch', 'unknown', { parked: P }), row('scratch', 'unknown', { parked: P, archived: true }), row('old', 'idle', { parked: P })]
  // parked-only and archived-parked projects are gone; the live one stays
  const queue = [row('zarvis', 'blocked'), row('old', 'idle', { parked: P })]
  assert.deepEqual(chipProjects(queue, parkedOnly).map((c) => c.project), ['zarvis'])
  assert.deepEqual(chipProjects([], parkedOnly), [])
  // a hook-signalled, unparked tree node keeps its project alive; one the hook never saw does not
  assert.deepEqual(chipProjects([], [row('a', 'idle'), row('b', 'unknown')]).map((c) => c.project), ['a'])
  // an archived or done node never keeps a project alive
  assert.deepEqual(chipProjects([], [row('a', 'idle', { archived: true }), row('b', 'idle', { done: true })]), [])
  // the exact report: scratch was remembered, its only session got parked/archived -> its chip vanishes -> All
  assert.equal(resolveProject('scratch', chipProjects(queue, parkedOnly)), '')
  // started again (a live row), the chip is back
  assert.equal(resolveProject('scratch', chipProjects([...queue, row('scratch', 'working')], parkedOnly)), 'scratch')
})

test('liveProjectNames: queue rows that are not parked, plus live tree nodes; never the interface', () => {
  const names = liveProjectNames([row('a', 'working'), row('b', 'idle', { parked: {} }), row('c', 'working', { role: 'interface' })], [row('d', 'blocked'), row('e', 'idle', { parked: {} })])
  assert.deepEqual([...names].sort(), ['a', 'd'])
})

test('hiddenParked counts parked, not done, non-interface sessions outside the filter', () => {
  const nodes = [row('a', 'idle', { parked: {} }), row('b', 'idle', { parked: {} }), row('b', 'idle', { parked: {}, done: true }), row('b', 'idle'), row('b', 'idle', { parked: {}, role: 'interface' })]
  assert.equal(hiddenParked(nodes, 'a'), 1)
  assert.equal(hiddenParked(nodes, 'b'), 1)
  assert.equal(hiddenParked(nodes, ''), 0)
})

test('ago gives a compact relative age', () => {
  const now = 10_000_000_000
  assert.equal(ago(now - 5_000, now), 'just now')
  assert.equal(ago(now - 5 * 60_000, now), '5m ago')
  assert.equal(ago(now - 2 * 3600_000, now), '2h ago')
  assert.equal(ago(now - 3 * 86400_000, now), '3d ago')
})

import { toggleRole, resolveRole, ROLE_FILTERS } from '../public/projects.js'

test('role filter: toggle, resolve, and composition with the project filter', () => {
  assert.deepEqual(ROLE_FILTERS, ['manager', 'worker'])
  assert.equal(toggleRole('', 'manager'), 'manager')
  assert.equal(toggleRole('manager', 'manager'), '') // again clears
  assert.equal(toggleRole('manager', 'worker'), 'worker') // other key switches
  assert.equal(toggleRole('', 'interface'), '')
  assert.equal(resolveRole('worker'), 'worker')
  assert.equal(resolveRole('bogus'), '')
  const rs = [row('a', 'blocked', { role: 'manager' }), row('a', 'blocked', { role: 'worker' }), row('b', 'blocked', { role: 'worker' }), row('b', 'working', { role: 'unclassified' }), row('x', 'idle', { role: 'interface' })]
  assert.deepEqual(filterRows(rs, '', 'worker').map((r) => r.project + r.role[0]), ['aw', 'bw', 'xi'])
  assert.deepEqual(filterRows(rs, 'a', 'worker').map((r) => r.project + r.role[0]), ['aw', 'xi'])
  assert.equal(filterRows(rs, '', '').length, rs.length)
  assert.equal(hiddenBlocked(rs, '', 'worker'), 1) // the manager's prompt is not lost silently
  assert.equal(hiddenBlocked(rs, 'a', 'worker'), 2)
  assert.equal(hiddenBlocked(rs, '', ''), 0)
})

import { hideParked } from '../public/projects.js'

test('hideParked drops parked sessions, keeps a manager with an unparked worker, and counts what it hid', () => {
  const n = (project, extra = {}) => ({ project, role: 'worker', ...extra })
  const P = { reason: 'x' }
  const t = {
    interface: [n('i', { role: 'interface', parked: P })], // never hidden
    managers: [
      { ...n('a', { role: 'manager' }), children: [n('a', { parked: P }), n('a')] }, // one worker stays
      { ...n('b', { role: 'manager' }), children: [n('b', { parked: P }), n('b', { parked: P })] }, // all parked: manager stays, empty
      { ...n('c', { role: 'manager', parked: P }), children: [n('c', { parked: P })] }, // parked with only parked workers: gone
      { ...n('d', { role: 'manager', parked: P }), children: [n('d')] }, // parked manager with a live worker: stays
    ],
    orphans: [n('e', { parked: P }), n('e')],
    unclassified: [n('f', { parked: P, done: true })], // done ones are not counted
  }
  const { tree, hidden } = hideParked(t)
  assert.equal(tree.interface.length, 1)
  assert.deepEqual(tree.managers.map((m) => [m.project, m.children.length]), [['a', 1], ['b', 0], ['d', 1]])
  assert.equal(tree.orphans.length, 1)
  assert.equal(tree.unclassified.length, 0)
  assert.equal(hidden, 1 + 2 + 2 + 1) // a's worker, b's two, c and its worker, e
})

import { nextView, VIEWS } from '../public/projects.js'

test('nextView cycles Queue -> Roles -> Parked -> Schedule and loops, both ways', () => {
  assert.deepEqual(VIEWS, ['queue', 'tree', 'parked', 'schedule'])
  assert.equal(nextView('queue'), 'tree')
  assert.equal(nextView('tree'), 'parked')
  assert.equal(nextView('parked'), 'schedule')
  assert.equal(nextView('schedule'), 'queue')
  assert.equal(nextView('queue', -1), 'schedule')
  assert.equal(nextView('tree', -1), 'queue')
  assert.equal(nextView('bogus'), 'tree')
})

test('the project filter applies to archived parked sessions too', () => {
  const t = { interface: [], managers: [], orphans: [], unclassified: [], archived: [row('a', 'unknown'), row('b', 'unknown')] }
  assert.deepEqual(filterTreeByProject(t, 'b').archived.map((n) => n.project), ['b'])
  assert.equal(filterTreeByProject(t, '').archived.length, 2)
})
