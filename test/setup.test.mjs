import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addHooks, hasHooks, hookCommand, removeHooks, HOOK_EVENTS } from '../lib/hook-config.mjs'
import { fileURLToPath } from 'node:url'
import { run, render } from '../scripts/setup.mjs'
import { execFile } from 'node:child_process'

const HOOK = '/opt/zarvis/hooks/zarvis-hook.mjs'
const OTHER = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }

test('addHooks adds one entry per event and keeps everything else', () => {
  const before = { model: 'opus', hooks: { PreToolUse: [OTHER] } }
  const after = addHooks(before, HOOK)
  assert.equal(after.model, 'opus')
  assert.deepEqual(Object.keys(after.hooks).sort(), Object.keys(HOOK_EVENTS).sort())
  assert.deepEqual(after.hooks.PreToolUse[0], OTHER, 'the user hook is untouched and stays first')
  assert.equal(after.hooks.PreToolUse[1].hooks[0].command, hookCommand(HOOK, 'resume'))
  assert.equal(after.hooks.PreToolUse[1].hooks[0].timeout, undefined)
  // the claim guard is its own entry beside `resume`, so the two run in parallel, with an explicit timeout
  assert.equal(after.hooks.PreToolUse.length, 3)
  assert.deepEqual(after.hooks.PreToolUse[2], { hooks: [{ type: 'command', command: hookCommand(HOOK, 'guard'), timeout: 5 }] })
  assert.equal(after.hooks.PostToolUse.length, 2)
  assert.deepEqual(after.hooks.PostToolUse[1], { hooks: [{ type: 'command', command: hookCommand(HOOK, 'guardpost'), timeout: 5 }] })
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
  assert.equal(moved.hooks.PreToolUse.length, 2, 'moving the clone replaces both PreToolUse entries, not adds')
  assert.match(moved.hooks.Stop[0].hooks[0].command, /\/new\/place\//)
  assert.equal(hasHooks(moved, HOOK), false)
})

test('hasHooks ignores event order and other people\'s hooks, but not a changed or missing Zarvis entry', () => {
  const once = addHooks({ hooks: { PreToolUse: [OTHER] } }, HOOK)
  const reordered = { hooks: Object.fromEntries(Object.entries(once.hooks).reverse()) }
  assert.equal(hasHooks(reordered, HOOK), true, 'same hooks, different event order')
  assert.equal(hasHooks({ hooks: { ...once.hooks, PreToolUse: [...once.hooks.PreToolUse.slice(1), once.hooks.PreToolUse[0]] } }, HOOK), true, 'our groups before or after others')
  const dropped = structuredClone(once)
  delete dropped.hooks.SubagentStop
  assert.equal(hasHooks(dropped, HOOK), false, 'a missing event')
  const changed = structuredClone(once)
  changed.hooks.Stop[0].hooks[0].command = hookCommand(HOOK, 'done')
  assert.equal(hasHooks(changed, HOOK), false, 'a wrong mode')
  assert.equal(hasHooks({}, HOOK), false)
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
  assert.equal(installed.hooks.PreToolUse.length, 3, 'the user hook, resume and guard')
  assert.equal(installed.hooks.PreToolUse[2].hooks[0].timeout, 5)
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

const ZARVIS_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SKILL_SRC = new URL('../skills/zarvis-interface/SKILL.md', import.meta.url)
const MANAGER_SRC = new URL('../skills/zarvis-manager/SKILL.md', import.meta.url)

async function sandbox() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-skill-'))
  const settings = path.join(dir, 'settings.json')
  const dest = path.join(dir, 'skills', 'zarvis-interface', 'SKILL.md')
  return { dir, settings, dest, run: (args) => run([...args, '--settings', settings], () => {}) }
}

test('the shipped skill has the frontmatter Claude needs and the spec sections in order', async () => {
  const text = await fsp.readFile(SKILL_SRC, 'utf8')
  assert.match(text, /^---\nname: zarvis-interface\ndescription: .*\[zarvis: role=interface\]/s)
  const heads = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(heads, ['Role', 'Orient', 'May do', 'Ask first', 'Must not', 'Report format', 'Handoff briefs', 'Closing the loop'])
})

test('every shipped skill has frontmatter that is valid YAML for name and description', async () => {
  const root = fileURLToPath(new URL('../skills/', import.meta.url))
  const dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory())
  assert.ok(dirs.length >= 3)
  for (const d of dirs) {
    const text = await fsp.readFile(path.join(root, d.name, 'SKILL.md'), 'utf8')
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
    assert.ok(m, `${d.name}: opens with --- and closes with ---`)
    const lines = m[1].split('\n')
    const field = (k) => lines.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim()
    assert.equal(field('name'), d.name, 'name matches the folder')
    const desc = field('description')
    // A plain scalar with ": " or " #" is invalid YAML and makes Claude Code drop every field.
    const quoted = /^"(?:[^"\\]|\\.)*"$/.test(desc) || /^'(?:[^']|'')*'$/.test(desc)
    const block = /^[>|][+-]?$/.test(desc)
    assert.ok(quoted || block, `${d.name}: description must be a quoted string or block scalar`)
    if (quoted) assert.ok(JSON.parse(desc.startsWith('"') ? desc : `"${desc.slice(1, -1)}"`).length < 1536, 'under 1,536 chars')
    for (const l of lines.filter((l) => !l.startsWith('name:') && !l.startsWith('description:'))) assert.ok(/^\s/.test(l) || !l.trim(), `${d.name}: unexpected frontmatter line ${l}`)
  }
})

test('setup installs the skill beside the settings, and re-running changes nothing', async () => {
  const s = await sandbox()
  await s.run([])
  const shipped = render(await fsp.readFile(SKILL_SRC, 'utf8'))
  assert.equal(await fsp.readFile(s.dest, 'utf8'), shipped)
  const before = await fsp.readdir(path.dirname(s.dest))
  await s.run([])
  assert.deepEqual(await fsp.readdir(path.dirname(s.dest)), before, 'no backup when identical')
})

test('a differing SKILL.md is backed up before it is overwritten', async () => {
  const s = await sandbox()
  await fsp.mkdir(path.dirname(s.dest), { recursive: true })
  await fsp.writeFile(s.dest, 'my edits')
  await s.run([])
  const files = await fsp.readdir(path.dirname(s.dest))
  const backup = files.find((f) => f.includes('zarvis-backup'))
  assert.equal(await fsp.readFile(path.join(path.dirname(s.dest), backup), 'utf8'), 'my edits')
  assert.equal(await fsp.readFile(s.dest, 'utf8'), render(await fsp.readFile(SKILL_SRC, 'utf8')))
})

test('uninstall removes the skill and its empty folder, and leaves other skills alone', async () => {
  const s = await sandbox()
  const other = path.join(s.dir, 'skills', 'other', 'SKILL.md')
  await fsp.mkdir(path.dirname(other), { recursive: true })
  await fsp.writeFile(other, 'theirs')
  await s.run([])
  await s.run(['uninstall'])
  await assert.rejects(fsp.access(path.dirname(s.dest)))
  assert.equal(await fsp.readFile(other, 'utf8'), 'theirs')
  await s.run(['uninstall']) // nothing left: still fine
})

test('uninstall backs up an edited skill and keeps its folder', async () => {
  const s = await sandbox()
  await s.run([])
  await fsp.writeFile(s.dest, 'edited')
  await s.run(['uninstall'])
  const files = await fsp.readdir(path.dirname(s.dest))
  assert.equal(files.length, 1)
  assert.match(files[0], /SKILL\.md\.zarvis-backup-/)
})

test('--dry-run writes neither the settings nor the skill', async () => {
  const s = await sandbox()
  const logs = []
  await run(['--dry-run', '--settings', s.settings], (l) => logs.push(l))
  await assert.rejects(fsp.access(path.join(s.dir, 'skills')))
  assert.ok(logs.some((l) => /Would write .*SKILL\.md/.test(l)))
})

test('an unusable skill path stops setup before anything is written', async () => {
  const s = await sandbox()
  await fsp.mkdir(path.join(s.dir, 'skills'), { recursive: true })
  await fsp.writeFile(path.join(s.dir, 'skills', 'zarvis-interface'), 'a file, not a folder')
  await assert.rejects(s.run([]), /not a plain directory/)
  await assert.rejects(fsp.access(s.settings), 'hooks not written either')
})

test('setup installs and removes the manager skill alongside the interface one', async () => {
  const s = await sandbox()
  const dest = path.join(s.dir, 'skills', 'zarvis-manager', 'SKILL.md')
  await s.run([])
  const template = await fsp.readFile(MANAGER_SRC, 'utf8')
  assert.equal(await fsp.readFile(dest, 'utf8'), template.split('{{ZARVIS_DIR}}').join(ZARVIS_DIR))
  assert.match(await fsp.readFile(MANAGER_SRC, 'utf8'), /^---\nname: zarvis-manager\ndescription: .*\[zarvis: role=manager\]/s)
  await fsp.writeFile(dest, 'edited')
  await s.run([])
  assert.equal((await fsp.readdir(path.dirname(dest))).filter((f) => f.includes('zarvis-backup')).length, 1)
  await s.run(['uninstall'])
  await assert.rejects(fsp.access(s.dest))
  assert.equal((await fsp.readdir(path.dirname(dest))).length, 1, 'only the manager backup remains')
})

test('the installed manager skill points at this clone\'s park script; the repo copy keeps the placeholder', async () => {
  const s = await sandbox()
  const dest = path.join(s.dir, 'skills', 'zarvis-manager', 'SKILL.md')
  await s.run([])
  const text = await fsp.readFile(dest, 'utf8')
  assert.ok(!text.includes('{{ZARVIS_DIR}}'))
  assert.ok(text.includes(`node "${ZARVIS_DIR}/scripts/park.mjs" park`))
  assert.ok((await fsp.readFile(MANAGER_SRC, 'utf8')).includes('{{ZARVIS_DIR}}'))
  await fsp.access(path.join(ZARVIS_DIR, 'scripts', 'park.mjs'))
})

test('a skill rendered for a moved clone is replaced and removed without a backup; an edited one is backed up', async () => {
  const s = await sandbox()
  const dest = path.join(s.dir, 'skills', 'zarvis-manager', 'SKILL.md')
  const dir = path.dirname(dest)
  await s.run([])
  const mine = await fsp.readFile(dest, 'utf8')
  await fsp.writeFile(dest, mine.split(ZARVIS_DIR).join('/old/place/zarvis'))
  await s.run([])
  assert.equal(await fsp.readFile(dest, 'utf8'), mine, 're-install repoints it')
  assert.equal((await fsp.readdir(dir)).length, 1, 'no backup for our own old copy')
  await fsp.writeFile(dest, mine.split(ZARVIS_DIR).join('/old/place/zarvis'))
  await s.run(['uninstall'])
  await assert.rejects(fsp.access(dir), 'uninstall of a moved copy leaves nothing')
  await s.run([])
  await fsp.writeFile(dest, `${mine}\nmy edit`)
  await s.run([])
  assert.equal((await fsp.readdir(dir)).filter((f) => f.includes('zarvis-backup')).length, 1)
})

test('the installed park command survives clone paths with $, backticks, quotes and spaces', async () => {
  const template = await fsp.readFile(MANAGER_SRC, 'utf8')
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-q-'))
  const odd = ['$HOME dir', 'back`tick`', 'dq"uote', "sq'uote", 'sp ace', '$(touch pwned)']  // (a backslash in a directory name is refused by Node's ESM loader itself, whatever the quoting)
  for (const name of odd) {
    const clone = path.join(base, name)
    await fsp.mkdir(path.join(clone, 'scripts'), { recursive: true })
    await fsp.cp(path.join(ZARVIS_DIR, 'lib'), path.join(clone, 'lib'), { recursive: true })
    await fsp.copyFile(path.join(ZARVIS_DIR, 'scripts', 'park.mjs'), path.join(clone, 'scripts', 'park.mjs'))
    await fsp.copyFile(path.join(ZARVIS_DIR, 'package.json'), path.join(clone, 'package.json'))
    const text = render(template, clone)
    const line = text.split('\n').find((l) => l.includes('park.mjs" list'))
    const cmd = line.replace('<your session id>', 'aaaaaaaa-0000-4000-8000-000000000000')
    const env = { ...process.env, ZARVIS_HOME: path.join(base, 'home'), ZARVIS_DESKTOP_SESSIONS: path.join(base, 'none'), HOME: '/nonexistent-home' }
    const out = await new Promise((resolve) => execFile('sh', ['-c', cmd], { env, cwd: base }, (err, stdout, stderr) => resolve({ err, stdout, stderr })))
    assert.equal(out.err, null, `${name}: ${out.stderr}`)
    assert.match(out.stdout, /nothing parked/, name)
  }
  await assert.rejects(fsp.access(path.join(base, 'pwned')), 'no command substitution ran')
  assert.ok(!(await fsp.readdir(base)).includes('pwned'))
})

test('setup installs and removes the worker skill, with the placeholder rendered', async () => {
  const s = await sandbox()
  const src = new URL('../skills/zarvis-worker/SKILL.md', import.meta.url)
  const template = await fsp.readFile(src, 'utf8')
  assert.match(template, /^---\nname: zarvis-worker\ndescription: "[^\n]*\[zarvis: role=worker parent=<manager session id>\]/)
  const dest = path.join(s.dir, 'skills', 'zarvis-worker', 'SKILL.md')
  const logs = []
  await run(['--dry-run', '--settings', s.settings], (l) => logs.push(l))
  assert.ok(logs.some((l) => l.includes(`Would write ${dest}`)))
  await assert.rejects(fsp.access(dest), 'dry run wrote nothing')
  await s.run([])
  const text = await fsp.readFile(dest, 'utf8')
  assert.equal(text, template.split('{{ZARVIS_DIR}}').join(ZARVIS_DIR))
  assert.ok(text.includes(`node "${ZARVIS_DIR}/scripts/claims.mjs" claim`))
  const before = await fsp.readdir(path.dirname(dest))
  await s.run([])
  assert.deepEqual(await fsp.readdir(path.dirname(dest)), before, 'idempotent, no backup')
  await fsp.writeFile(dest, 'edited')
  await s.run([])
  assert.equal((await fsp.readdir(path.dirname(dest))).filter((f) => f.includes('zarvis-backup')).length, 1)
  await s.run(['uninstall'])
  await assert.rejects(fsp.access(dest))
})

test('the manager skill tells managers to tag workers, set a Reporting line in each brief and batch feedback', async () => {
  const text = await fsp.readFile(MANAGER_SRC, 'utf8')
  assert.match(text, /\[zarvis: role=worker parent=<your session id>\]/)
  assert.match(text, /Reporting: user review/)
  assert.match(text, /Batch review feedback/)
})
