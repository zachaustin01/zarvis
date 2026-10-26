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
