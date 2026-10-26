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

import { chipProjects, resolveProject, hiddenParked, ago } from '../public/projects.js'

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

test('a parked session adds its project as a chip even without a hook signal', () => {
  const chips = chipProjects([row('zarvis', 'blocked')], [row('old-repo', 'unknown', { parked: { reason: 'x' } })])
  assert.deepEqual(chips.map((c) => c.project), ['old-repo', 'zarvis'])
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
