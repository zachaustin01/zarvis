import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addHooks, hasHooks, hookCommand, removeHooks, HOOK_EVENTS } from '../lib/hook-config.mjs'
import { run } from '../scripts/setup.mjs'

const HOOK = '/opt/zarvis/hooks/zarvis-hook.mjs'
const OTHER = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }

test('addHooks adds one entry per event and keeps everything else', () => {
  const before = { model: 'opus', hooks: { PreToolUse: [OTHER] } }
  const after = addHooks(before, HOOK)
  assert.equal(after.model, 'opus')
  assert.deepEqual(Object.keys(after.hooks).sort(), Object.keys(HOOK_EVENTS).sort())
  assert.deepEqual(after.hooks.PreToolUse[0], OTHER, 'the user hook is untouched and stays first')
  assert.equal(after.hooks.PreToolUse[1].hooks[0].command, hookCommand(HOOK, 'resume'))
  assert.equal(after.hooks.Notification[0].matcher, 'permission_prompt')
  assert.equal(after.hooks.Notification[0].hooks[0].command, hookCommand(HOOK, 'set'))
  assert.deepEqual(before, { model: 'opus', hooks: { PreToolUse: [OTHER] } }, 'input not mutated')
})

test('addHooks is idempotent and follows a moved clone', () => {
  const once = addHooks({}, HOOK)
  assert.deepEqual(addHooks(once, HOOK), once)
  assert.equal(hasHooks(once, HOOK), true)
  const moved = addHooks(once, '/new/place/hooks/zarvis-hook.mjs')
  assert.equal(moved.hooks.Stop.length, 1)
  assert.match(moved.hooks.Stop[0].hooks[0].command, /\/new\/place\//)
  assert.equal(hasHooks(moved, HOOK), false)
})

test('removeHooks takes out only Zarvis entries, then empty groups, events and hooks', () => {
  const mixed = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: hookCommand(HOOK, 'clear') }] }
  const settings = addHooks({ hooks: { PreToolUse: [mixed] } }, HOOK)
  const out = removeHooks(settings)
  assert.deepEqual(out, { hooks: { PreToolUse: [OTHER] } })
  assert.deepEqual(removeHooks(addHooks({ theme: 'dark' }, HOOK)), { theme: 'dark' })
  assert.deepEqual(removeHooks({}), {})
})

test('hookCommand quotes paths with spaces and shell characters', () => {
  assert.equal(hookCommand('/Users/a b/zarvis-hook.mjs', 'set'), 'node "/Users/a b/zarvis-hook.mjs" set')
  assert.equal(hookCommand('/x/$y"z/zarvis-hook.mjs', 'set'), 'node "/x/\\$y\\"z/zarvis-hook.mjs" set')
})

test('setup installs, backs up, re-runs cleanly and uninstalls', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-setup-'))
  const file = path.join(dir, 'settings.json')
  await fsp.writeFile(file, JSON.stringify({ hooks: { PreToolUse: [OTHER] } }))
  const logs = []
  const log = (s) => logs.push(s)

  await run(['--settings', file], log)
  const installed = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(installed.hooks.Stop.length, 1)
  assert.equal(installed.hooks.PreToolUse.length, 2)
  assert.equal((await fsp.readdir(dir)).filter((f) => f.includes('zarvis-backup')).length, 1)

  await run(['--settings', file], log)
  assert.match(logs.at(-1), /already installed/)

  await run(['uninstall', '--settings', file], log)
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { hooks: { PreToolUse: [OTHER] } })
})

test('setup creates a missing file, and refuses to touch invalid JSON', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-setup-'))
  const fresh = path.join(dir, 'nested', 'settings.json')
  await run(['--settings', fresh], () => {})
  assert.equal(JSON.parse(await fsp.readFile(fresh, 'utf8')).hooks.Notification.length, 1)

  const broken = path.join(dir, 'broken.json')
  await fsp.writeFile(broken, '{ "hooks": ')
  await assert.rejects(run(['--settings', broken], () => {}), /not valid JSON/)
  assert.equal(await fsp.readFile(broken, 'utf8'), '{ "hooks": ')
})

test('--dry-run writes nothing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-setup-'))
  const file = path.join(dir, 'settings.json')
  const logs = []
  await run(['--dry-run', '--settings', file], (s) => logs.push(s))
  await assert.rejects(fsp.access(file))
  assert.match(logs[0], /zarvis-hook\.mjs/)
})
