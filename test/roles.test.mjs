import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { classify, childrenOf, roleMarker, rolePrompt, isNewSessionRole } from '../lib/roles.mjs'
import { renderRoster } from '../lib/roster.mjs'
import { applyRoles } from '../lib/queue.mjs'
import { setRole, readState } from '../lib/state.mjs'
import { buildRoleTag } from '../hooks/zarvis-hook.mjs'

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const rec = (n, extra = {}) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `S${n}`, cwd: `/r/${n}`, ...extra })
const spawnedBy = (n) => ({ spawnedFrom: { sessionId: `local_${id(n)}` } })

test('explicit tags win; a worker spawned by a tagged manager attaches to it', () => {
  const nodes = classify({ records: [rec(1), rec(2), rec(3, spawnedBy(2))], roles: { [id(1)]: { role: 'interface' }, [id(2)]: { role: 'manager' } } })
  assert.equal(nodes.get(id(1)).role, 'interface')
  assert.equal(nodes.get(id(3)).role, 'worker')
  assert.equal(nodes.get(id(3)).managerId, id(2))
  assert.deepEqual(childrenOf(nodes).get(id(2)).map((n) => n.sessionId), [id(3)])
})

test('spawn links from the interface are ignored; a spawner is only suggested as manager', () => {
  const nodes = classify({ records: [rec(1), rec(2, spawnedBy(1)), rec(3), rec(4, spawnedBy(3))], roles: { [id(1)]: { role: 'interface' } } })
  assert.equal(nodes.get(id(2)).role, 'unclassified', 'spawned by the interface: not a worker')
  assert.equal(nodes.get(id(3)).role, 'unclassified')
  assert.equal(nodes.get(id(3)).suggested, 'manager')
  assert.equal(nodes.get(id(4)).role, 'unclassified', 'its parent is not a confirmed manager yet')
})

test('archived sessions are left out and invariants warn without blocking', () => {
  const nodes = classify({
    records: [rec(1), rec(2), rec(3, { isArchived: true }), rec(4)],
    roles: { [id(1)]: { role: 'interface' }, [id(2)]: { role: 'interface' }, [id(4)]: { role: 'manager', parent: id(1) } },
  })
  assert.equal(nodes.has(id(3)), false)
  assert.match(nodes.get(id(1)).warnings[0], /more than one interface/)
  assert.match(nodes.get(id(4)).warnings[0], /no manager/)
})

test('a manager with a blocked worker rolls up as waiting_on_child, never as needs-you', () => {
  const nodes = classify({ records: [rec(2), rec(3, spawnedBy(2))], roles: { [id(2)]: { role: 'manager' } } })
  const row = (n, state) => ({ sessionId: id(n), state, since: 1, name: `S${n}`, prompt: 'p' })
  const out = applyRoles([row(2, 'working'), row(3, 'blocked')], nodes)
  assert.deepEqual(out.map((r) => [r.sessionId, r.state]), [[id(3), 'blocked'], [id(2), 'waiting_on_child']])
  assert.equal(out[1].blockedChildren[0].sessionId, id(3))
  assert.equal(out[0].role, 'worker')
})

test('registry: setRole stores a worker parent, clears on empty, rejects bad roles', async () => {
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-')), 'state.json')
  await setRole(id(3), 'worker', id(2), file)
  assert.equal((await readState(file)).roles[id(3)].parent, id(2))
  await setRole(id(3), '', '', file)
  assert.deepEqual((await readState(file)).roles, {})
  await assert.rejects(setRole(id(3), 'boss', '', file), /bad role/)
})

test('hook reads a role marker from the start of the prompt', () => {
  assert.deepEqual(buildRoleTag({ session_id: id(2), prompt: '[zarvis: role=Manager] Hi' }, 5), { sessionId: id(2), role: 'manager', parent: '', at: 5 })
  assert.equal(buildRoleTag({ session_id: id(3), prompt: `[zarvis: role=worker parent=${id(2)}]` }).parent, id(2))
  assert.equal(buildRoleTag({ session_id: id(3), prompt: 'no marker' }), null)
})

test('roleMarker only builds tags for real roles and clean parents', () => {
  assert.equal(roleMarker('manager'), '[zarvis: role=manager]')
  assert.equal(roleMarker('worker', id(2)), `[zarvis: role=worker parent=${id(2)}]`)
  assert.equal(roleMarker('worker', 'a b]'), '[zarvis: role=worker]')
  assert.equal(roleMarker('boss'), '')
  assert.equal(roleMarker(''), '')
})

test('roster lists each manager with its workers and is stable across renders', () => {
  const w = { sessionId: id(3), desktopSessionId: `local_${id(3)}`, name: 'Fix  login', state: 'blocked', project: 'api', branch: 'main' }
  const tree = { interface: [], managers: [{ sessionId: id(2), name: 'Auth', project: 'api', children: [w] }, { sessionId: id(4), name: 'Empty', project: '', children: [] }], orphans: [], unclassified: [] }
  const text = renderRoster(tree)
  assert.match(text, /## Manager: Auth/)
  assert.match(text, /Fix login — blocked — api › main/)
  assert.match(text, new RegExp(`session \\\`${id(3)}\\\``))
  assert.match(text, /workers: none attached/)
  assert.equal(renderRoster(tree), text)
  assert.match(renderRoster({ interface: [], managers: [], orphans: [], unclassified: [] }), /No managers yet/)
})

test('rolePrompt gives the interface and managers a pointer line, and others only the tag', () => {
  assert.equal(rolePrompt('interface'), '[zarvis: role=interface] Use the zarvis-interface skill (installed by npm run setup) for your role. The roster is ~/.zarvis/roster.md.')
  assert.equal(rolePrompt('manager', '', '/r.md'), '[zarvis: role=manager] Your workers are listed in /r.md. Use the zarvis-manager skill (installed by npm run setup) for your role.')
  assert.equal(rolePrompt('worker', id(2)), `[zarvis: role=worker parent=${id(2)}]`)
  assert.equal(rolePrompt('boss'), '')
  assert.equal(rolePrompt('interface').startsWith(roleMarker('interface')), true, 'the hook-parsed tag leads')
})

test('only a real role or an empty one may start a new session', () => {
  for (const ok of ['interface', 'manager', 'worker', '', undefined]) assert.equal(isNewSessionRole(ok), true, String(ok))
  for (const bad of ['boss', 'Manager', 'p', 7]) assert.equal(isNewSessionRole(bad), false, String(bad))
})
