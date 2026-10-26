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
