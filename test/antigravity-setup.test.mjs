import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  addAntigravityHooks,
  hasAntigravityHooks,
  removeAntigravityHooks,
  buildAntigravityHookConfig,
} from '../lib/antigravity-hook-config.mjs'
import { run } from '../scripts/setup.mjs'

const HOOK = '/opt/zarvis/hooks/zarvis-antigravity-hook.mjs'

test('addAntigravityHooks adds zarvis config and preserves existing custom hooks', () => {
  const existing = {
    'custom-linter': {
      PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }],
    },
  }
  const result = addAntigravityHooks(existing, HOOK)
  assert.ok(result['custom-linter'])
  assert.ok(result.zarvis)
  assert.equal(result.zarvis.SessionStart[0].command, `node "/opt/zarvis/hooks/zarvis-antigravity-hook.mjs" session_start`)
  assert.equal(result.zarvis.PreInvocation[0].command, `node "/opt/zarvis/hooks/zarvis-antigravity-hook.mjs" pre_invocation`)
  assert.equal(result.zarvis.PreToolUse[0].hooks[0].command, `node "/opt/zarvis/hooks/zarvis-antigravity-hook.mjs" pre_tool_use`)
  assert.equal(result.zarvis.PostToolUse[0].hooks[0].command, `node "/opt/zarvis/hooks/zarvis-antigravity-hook.mjs" post_tool_use`)
  assert.equal(result.zarvis.Stop[0].command, `node "/opt/zarvis/hooks/zarvis-antigravity-hook.mjs" stop`)

  assert.equal(hasAntigravityHooks(result, HOOK), true)
  assert.equal(hasAntigravityHooks(result, '/different/path.mjs'), false)
})

test('removeAntigravityHooks removes zarvis and keeps other hooks', () => {
  const existing = {
    zarvis: buildAntigravityHookConfig(HOOK),
    'other-hook': { Stop: [] },
  }
  const cleaned = removeAntigravityHooks(existing)
  assert.equal(cleaned.zarvis, undefined)
  assert.ok(cleaned['other-hook'])
})

test('setup installs Antigravity hooks and skills, backs up, and uninstalls cleanly', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-agy-setup-'))
  const hooksFile = path.join(dir, 'hooks.json')
  const skillsDir = path.join(dir, 'skills')

  const logs = []
  const log = (msg) => logs.push(msg)

  // 1. Install
  await run(['--antigravity-hooks', hooksFile, '--antigravity-skills-dir', skillsDir], log)
  const installed = JSON.parse(await fsp.readFile(hooksFile, 'utf8'))
  assert.ok(installed.zarvis)
  assert.equal(installed.zarvis.PreInvocation.length, 1)

  // Verify skills were installed
  for (const name of ['zarvis-interface', 'zarvis-manager', 'zarvis-worker']) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md')
    const content = await fsp.readFile(skillPath, 'utf8')
    assert.match(content, /---\nname: zarvis-/)
  }

  // 2. Re-run is idempotent
  await run(['--antigravity-hooks', hooksFile, '--antigravity-skills-dir', skillsDir], log)
  assert.match(logs.at(-1), /already installed/)

  // 3. Uninstall
  await run(['uninstall', '--antigravity-hooks', hooksFile, '--antigravity-skills-dir', skillsDir], log)
  const afterUninstall = JSON.parse(await fsp.readFile(hooksFile, 'utf8'))
  assert.equal(afterUninstall.zarvis, undefined)

  for (const name of ['zarvis-interface', 'zarvis-manager', 'zarvis-worker']) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md')
    await assert.rejects(fsp.readFile(skillPath, 'utf8'), { code: 'ENOENT' })
  }
})
