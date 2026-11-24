import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  GUARD_TIMEOUT_MS,
  getHome,
  isSafeId,
  readTail,
  readHead,
  readJson,
  writeAtomic,
  clearMarker,
  readStdinJson,
  stripLeadingSystemReminders,
  parseRoleTag,
  claimFirstPrompt,
  writeRoleTag,
  buildClaimsContext,
  runAutoEvents,
  runAutoLinks,
} from '../lib/hook-common.mjs'

const ID = 'f6cce3a1-cd4c-4de5-bb8d-e7375ea36a85'
const PARENT = 'a1b2c3d4-0000-4000-8000-123456789abc'

test('GUARD_TIMEOUT_MS and isSafeId enforce safety invariants', () => {
  assert.equal(GUARD_TIMEOUT_MS, 400)
  assert.equal(isSafeId(ID), true)
  assert.equal(isSafeId('abc_1234'), true)
  assert.equal(isSafeId('../escape'), false)
  assert.equal(isSafeId('short'), false)
  assert.equal(isSafeId(null), false)
})

test('getHome respects ZARVIS_HOME dynamically', () => {
  const prev = process.env.ZARVIS_HOME
  try {
    process.env.ZARVIS_HOME = '/tmp/zarvis-custom-home'
    assert.equal(getHome(), '/tmp/zarvis-custom-home')
  } finally {
    if (prev === undefined) delete process.env.ZARVIS_HOME
    else process.env.ZARVIS_HOME = prev
  }
})

test('writeAtomic, readJson, and clearMarker manage marker files safely', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hc-'))
  const file = path.join(dir, 'nested', `${ID}.json`)

  assert.equal(await readJson(file), null)
  await writeAtomic(file, { sessionId: ID, at: 123 })
  assert.deepEqual(await readJson(file), { sessionId: ID, at: 123 })

  await fsp.writeFile(file, '{malformed', 'utf8')
  assert.equal(await readJson(file), null)

  await clearMarker(file)
  assert.equal(await readJson(file), null)
  await clearMarker(file) // idempotent on missing file
})

test('readTail and readHead read bounded slices of a file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hc-'))
  const file = path.join(dir, 'log.txt')
  await fsp.writeFile(file, '0123456789abcdef', 'utf8')

  assert.equal(await readHead(file, 6), '012345')
  assert.equal(await readTail(file, 6), 'abcdef')
  assert.equal(await readTail(file, 100), '0123456789abcdef')
})

test('readStdinJson parses valid JSON and returns null on invalid input', async () => {
  assert.deepEqual(await readStdinJson(Readable.from(['{"ok":', 'true}'])), { ok: true })
  assert.equal(await readStdinJson(Readable.from(['not json'])), null)
  assert.equal(await readStdinJson(Readable.from([])), null)
})

test('stripLeadingSystemReminders and parseRoleTag handle single-line and multiline tags', () => {
  const raw = '<system-reminder>abc</system-reminder>\n<system-reminder>def</system-reminder>\n[zarvis: role=manager] go'
  const stripped = stripLeadingSystemReminders(raw)
  assert.equal(stripped, '\n[zarvis: role=manager] go')
  assert.deepEqual(parseRoleTag(stripped, ID, 42), { sessionId: ID, role: 'manager', parent: '', at: 42 })

  assert.equal(parseRoleTag('hello\n[zarvis: role=worker]', ID, 42), null)
  assert.deepEqual(
    parseRoleTag(`hello\n@worker-1 [zarvis: role=worker parent=${PARENT}]`, ID, 42, { multiline: true }),
    { sessionId: ID, role: 'worker', parent: PARENT, at: 42 },
  )
})

test('claimFirstPrompt and writeRoleTag are atomic first-writer-wins', async () => {
  const rolesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hc-roles-'))
  assert.equal(await claimFirstPrompt(rolesDir, ID), true)
  assert.equal(await claimFirstPrompt(rolesDir, ID), false)

  await writeRoleTag(rolesDir, ID, { sessionId: ID, role: 'manager', parent: '', at: 10 })
  await writeRoleTag(rolesDir, ID, { sessionId: ID, role: 'worker', parent: PARENT, at: 20 })
  const saved = await readJson(path.join(rolesDir, `${ID}.json`))
  assert.deepEqual(saved, { sessionId: ID, role: 'manager', parent: '', at: 10 })
})

test('buildClaimsContext, runAutoEvents, and runAutoLinks are fail-safe', async () => {
  const ctx = buildClaimsContext({ realDeps: { a: 1 }, sessionProcess: () => 99, sessionName: (s) => s }, '/tmp/h')
  assert.equal(ctx.home, '/tmp/h')
  assert.deepEqual(ctx.deps, { a: 1 })
  assert.equal(ctx.self(), 99)
  assert.equal(ctx.name('x'), 'x')

  // Non-matching tools return immediately without throwing
  await runAutoEvents({ tool_name: 'Read', tool_input: { file_path: '/x' } }, '/tmp/h')
  await runAutoLinks({ tool_name: 'Bash', tool_input: { command: 'ls' } }, '/tmp/h')
})
