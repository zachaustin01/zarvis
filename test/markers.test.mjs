import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseMarker, readMarkers } from '../lib/markers.mjs'
import { pendingTool, buildMarker, summarizeInput } from '../hooks/zarvis-hook.mjs'

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
