import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseMarker, readMarkers, hookStatus } from '../lib/markers.mjs'
import { pendingTool, buildMarker, buildWorking, summarizeInput } from '../hooks/zarvis-hook.mjs'

const ID = 'f6cce3a1-cd4c-4de5-bb8d-e7375ea36a85'

test('parseMarker accepts a valid marker and rejects bad ones', () => {
  assert.equal(parseMarker({ sessionId: ID, at: 5, tool: 'Bash' }).tool, 'Bash')
  assert.equal(parseMarker({ sessionId: '../x', at: 5 }), null)
  assert.equal(parseMarker({ sessionId: ID }), null)
  assert.equal(parseMarker(null), null)
})

test('readMarkers skips junk and mismatched file names', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-'))
  await fsp.writeFile(path.join(dir, `${ID}.json`), JSON.stringify({ sessionId: ID, at: 1 }))
  await fsp.writeFile(path.join(dir, 'broken.json'), '{nope')
  await fsp.writeFile(path.join(dir, 'other-session-id.json'), JSON.stringify({ sessionId: ID, at: 1 }))
  const got = await readMarkers(dir)
  assert.deepEqual(got.map((m) => m.sessionId), [ID])
  assert.deepEqual(await readMarkers(path.join(dir, 'missing')), [])
})

test('pendingTool finds the tool_use with no result after it', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'rm -rf build' } }] } },
  ].map((l) => JSON.stringify(l))
  assert.deepEqual(pendingTool('partial-line-garbage\n' + lines.join('\n')), { tool: 'Bash', command: 'rm -rf build' })
  assert.deepEqual(pendingTool(lines.slice(0, 2).join('\n')), { tool: '', command: '' })
})

test('buildMarker falls back to the message text for the tool name', async () => {
  const m = await buildMarker({ session_id: ID, message: 'Claude needs your permission to use WebFetch' }, 42)
  assert.equal(m.tool, 'WebFetch')
  assert.equal(m.at, 42)
  assert.equal(summarizeInput('Edit', { file_path: '/a/b' }), '/a/b')
})

test('buildWorking keeps the turn start across refreshes and restarts it without one', () => {
  assert.equal(buildWorking({ session_id: ID }, { at: 10 }, 99).at, 10)
  assert.equal(buildWorking({ session_id: ID }, { at: 10 }, 99).seen, 99)
  assert.equal(buildWorking({ session_id: ID }, null, 99).at, 99)
})

test('buildWorking restarts the clock when the state changes', () => {
  assert.equal(buildWorking({ session_id: ID }, { at: 10, state: 'idle' }, 99).at, 99)
  assert.equal(buildWorking({ session_id: ID }, { at: 10, state: 'idle' }, 99, 'idle').at, 10)
  assert.equal(buildWorking({ session_id: ID }, null, 99, 'idle').state, 'idle')
})

test('hookStatus: live, stale, absent, and never a guess', () => {
  const now = 100_000_000
  const min = 60_000
  assert.deepEqual(hookStatus([], now), { status: 'absent', lastAt: 0 })
  assert.equal(hookStatus([{ at: now - 2 * min }], now).status, 'live') // blocked marker
  assert.equal(hookStatus([{ at: now - 60 * min, seen: now - min }], now).status, 'live') // working marker's seen wins
  const old = hookStatus([{ at: now - 30 * min }, { at: now - 20 * min, seen: now - 20 * min }], now)
  assert.deepEqual(old, { status: 'stale', lastAt: now - 20 * min })
  assert.equal(hookStatus([{ at: now - 11 * min }], now, 12 * min).status, 'live') // custom threshold
})

// ---- role tag: first prompt, at its start only ----
import { spawnSync } from 'node:child_process'
import { buildRoleTag } from '../hooks/zarvis-hook.mjs'
import { rolePrompt } from '../lib/roles.mjs'

const PARENT = 'a1b2c3d4-0000-4000-8000-123456789abc'
const HOOK = new URL('../hooks/zarvis-hook.mjs', import.meta.url).pathname

test('buildRoleTag only matches a tag at the start of the prompt', () => {
  const tag = (prompt) => buildRoleTag({ session_id: ID, prompt }, 7)
  assert.deepEqual(tag('[zarvis: role=manager] hi'), { sessionId: ID, role: 'manager', parent: '', at: 7 })
  assert.equal(tag('  \n\t[zarvis: role=interface] hi').role, 'interface')
  assert.equal(tag('Build the skill that handles [zarvis: role=interface] tags'), null)
  assert.equal(tag('hello\n[zarvis: role=worker]'), null)
  assert.equal(tag(`[zarvis: role=worker parent=${PARENT}]`).parent, PARENT)
  for (const [role, parent] of [['interface', ''], ['manager', ''], ['worker', PARENT]]) {
    const t = tag(rolePrompt(role, parent))
    assert.equal(t.role, role)
    assert.equal(t.parent, parent)
  }
})

test('the hook registers a role only from the first prompt, and never overwrites', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hook-'))
  const run = (mode, id, prompt) =>
    spawnSync('node', [HOOK, mode], { input: JSON.stringify({ session_id: id, prompt }), env: { ...process.env, ZARVIS_HOME: home } })
  const role = async (id) => {
    try {
      return JSON.parse(await fsp.readFile(path.join(home, 'roles', `${id}.json`), 'utf8'))
    } catch {
      return null
    }
  }
  const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  run('idle', A, '') // SessionStart first
  run('start', A, rolePrompt('manager'))
  assert.equal((await role(A)).role, 'manager')
  run('start', A, '[zarvis: role=interface]') // later prompt: no overwrite
  assert.equal((await role(A)).role, 'manager')

  const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  run('start', B, 'Please build the thing for [zarvis: role=interface]')
  run('start', B, '[zarvis: role=interface] now')
  assert.equal(await role(B), null)

  const C = 'cccccccc-3333-4333-8333-cccccccccccc'
  run('start', C, 'plain first prompt')
  run('start', C, rolePrompt('worker', PARENT))
  assert.equal(await role(C), null)

  const D = 'dddddddd-4444-4444-8444-dddddddddddd'
  await fsp.mkdir(path.join(home, 'roles'), { recursive: true })
  await fsp.writeFile(path.join(home, 'roles', `${D}.json`), JSON.stringify({ sessionId: D, role: 'worker', parent: '', at: 1 }))
  run('start', D, '[zarvis: role=manager]')
  assert.equal((await role(D)).role, 'worker')
})
