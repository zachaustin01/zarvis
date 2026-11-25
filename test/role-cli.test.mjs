import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runRole, parseArgs } from '../lib/role-cli.mjs'
import { readState } from '../lib/state.mjs'
import { classify, NO_ROLE } from '../lib/roles.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROLE_SCRIPT = path.join(ROOT, 'scripts', 'role.mjs')
const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const rec = (n, extra = {}) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `S${n}`, cwd: `/r/${n}`, ...extra })

function world(extra = {}) {
  return {
    records: [rec(1), rec(2), rec(3)],
    sessions: [{ sessionId: id(5), title: 'AGY Coordinator', runtime: 'antigravity', cwd: '/r/5' }],
    roles: {
      [id(1)]: { role: 'interface' },
      [id(7)]: { role: 'interface' }, // stale CLI-only hook tag not in desktop records
    },
    ...extra,
  }
}

async function harness(w = world()) {
  const stateFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-role-')), 'state.json')
  const out = []
  const errs = []
  const run = async (args) => ({
    code: await runRole(args, { deps: w, stateFile, log: (l) => out.push(l), err: (l) => errs.push(l) }),
    out: out.splice(0),
    err: errs.splice(0),
  })
  return { stateFile, run, world: w }
}

test('role CLI: parseArgs handles flags and rejects unknown options', () => {
  const a = parseArgs(['set', id(3), 'worker', '--parent', id(2), '--dry-run'])
  assert.deepEqual([a.cmd, a.args, a.parent, a.dryRun], ['set', [id(3), 'worker'], id(2), true])
  assert.throws(() => parseArgs(['set', '--unknown']), /unknown option/)
  assert.throws(() => parseArgs(['set', id(3), 'worker', '--parent']), /needs a value/)
})

test('role CLI: set resolves local_ desktop ids, Antigravity sessions, and raw CLI-only ids', async () => {
  const h = await harness()

  // Resolve local_ desktop id for both target and --parent
  let r = await h.run(['set', `local_${id(2)}`, 'manager'])
  assert.equal(r.code, 0)
  assert.match(r.out[0], /set “S2” .* to manager/)
  assert.equal((await readState(h.stateFile)).roles[id(2)].role, 'manager')

  r = await h.run(['set', `local_${id(3)}`, 'worker', '--parent', `local_${id(2)}`])
  assert.equal(r.code, 0)
  const stored = (await readState(h.stateFile)).roles[id(3)]
  assert.equal(stored.role, 'worker')
  assert.equal(stored.parent, id(2))

  // Antigravity session
  r = await h.run(['set', id(5), 'manager'])
  assert.equal(r.code, 0)
  assert.match(r.out[0], /AGY Coordinator/)
  assert.equal((await readState(h.stateFile)).roles[id(5)].role, 'manager')

  // Stale/closed CLI-only session not in desktop records at all
  const cliOnly = id(9)
  r = await h.run(['set', cliOnly, 'none'])
  assert.equal(r.code, 0)
  assert.equal((await readState(h.stateFile)).roles[cliOnly].role, NO_ROLE)
})

test('role CLI: clear sets NO_ROLE ("none") so hook-tagged stale interface sessions do not revert to roles/<id>.json; reset drops manual override', async () => {
  const h = await harness()

  // id(7) has a stale hook tag `{ role: 'interface' }` in roles/<id>.json and no desktop record
  let r = await h.run(['clear', id(7)])
  assert.equal(r.code, 0)
  assert.match(r.out[0], /cleared role .* \(set to none\)/)

  const stateAfterClear = await readState(h.stateFile)
  assert.equal(stateAfterClear.roles[id(7)].role, NO_ROLE)

  // Verify merged roleRegistry + classify leaves id(7) unclassified (source: 'cleared'), NOT 'interface'
  const nodes = classify({ records: h.world.records, roles: { ...h.world.roles, ...stateAfterClear.roles } })
  assert.equal(nodes.get(id(7)).role, 'unclassified')
  assert.equal(nodes.get(id(7)).source, 'cleared')

  // get --json reflects cleared state
  r = await h.run(['get', id(7), '--json'])
  assert.equal(r.code, 0)
  const info = JSON.parse(r.out[0])
  assert.equal(info.role, 'none')
  assert.equal(info.effectiveRole, 'unclassified')
  assert.equal(info.origin, 'state')

  // reset removes manual override in state.json so hook tag applies again
  r = await h.run(['reset', id(7)])
  assert.equal(r.code, 0)
  assert.equal((await readState(h.stateFile)).roles[id(7)], undefined)
  const afterReset = classify({ records: h.world.records, roles: { ...h.world.roles } })
  assert.equal(afterReset.get(id(7)).role, 'interface')
})

test('role CLI: validates roles, ids, --parent rules, and --dry-run', async () => {
  const h = await harness()
  for (const [args, msg] of [
    [[], /no command given/],
    [['bogus'], /unknown command bogus/],
    [['set', id(2)], /set needs <id>/],
    [['set', id(2), 'boss'], /role must be interface, manager, worker or none/],
    [['set', '../evil', 'manager'], /bad session id/],
    [['set', id(2), 'manager', '--parent', id(1)], /--parent is only valid when setting role to worker/],
    [['set', id(2), 'worker', '--parent', '../bad'], /bad --parent session id/],
    [['set', id(2), 'worker', '--parent', id(2)], /cannot be its own parent/],
    [['clear', id(2), '--parent', id(1)], /--parent is only valid/],
    [['clear'], /clear needs a session id/],
    [['get'], /get needs a session id/],
  ]) {
    const r = await h.run(args)
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.err[0], msg)
  }

  // --dry-run writes nothing
  const dry = await h.run(['set', id(2), 'manager', '--dry-run'])
  assert.equal(dry.code, 0)
  assert.match(dry.out[0], /^would set/)
  await assert.rejects(fsp.access(h.stateFile))
})

test('role CLI: list and list --json report hook, state, and spawn-promoted roles', async () => {
  const h = await harness()
  await h.run(['set', id(2), 'manager'])
  await h.run(['set', id(3), 'worker', '--parent', id(2)])

  const plain = await h.run(['list'])
  assert.equal(plain.code, 0)
  assert.ok(plain.out.some((l) => l.includes(`${id(2)}  manager (state)`)))
  assert.ok(plain.out.some((l) => l.includes(`${id(3)}  worker (state)`) && l.includes(`parent ${id(2)}`)))

  const jsonRes = await h.run(['list', '--json'])
  assert.equal(jsonRes.code, 0)
  const parsed = JSON.parse(jsonRes.out[0])
  assert.ok(Array.isArray(parsed.roles))
  assert.equal(parsed.roles.find((x) => x.sessionId === id(1)).origin, 'hook')
  assert.equal(parsed.roles.find((x) => x.sessionId === id(2)).origin, 'state')
})

test('scripts/role.mjs end-to-end + server /api/tree & roster.md: stale ghost interfaces suppressed and cleared cleanly', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-e2e-role-'))
  const desktop = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-e2e-desk-'))
  const realIface = id(1)
  const ghost1 = id(7)
  const ghost2 = id(8)

  const desktopOrg = path.join(desktop, 'acct', 'org')
  await fsp.mkdir(desktopOrg, { recursive: true })
  await fsp.writeFile(
    path.join(desktopOrg, `local_${realIface}.json`),
    JSON.stringify({
      sessionId: `local_${realIface}`,
      cliSessionId: realIface,
      title: 'Main Zarvis Interface',
      cwd: '/tmp/repo',
      lastActivityAt: Date.now() - 5000,
    }),
  )

  const rolesDir = path.join(home, 'roles')
  await fsp.mkdir(rolesDir, { recursive: true })
  for (const sid of [realIface, ghost1, ghost2]) {
    await fsp.writeFile(path.join(rolesDir, `${sid}.json`), JSON.stringify({ sessionId: sid, role: 'interface', parent: '', at: 100 }))
  }

  const env = {
    ...process.env,
    ZARVIS_HOME: home,
    ZARVIS_DESKTOP_SESSIONS: desktop,
    ANTIGRAVITY_HOME: path.join(home, 'empty-agy'),
    ZARVIS_DRY_OPEN: '1',
    ZARVIS_COSTS_WARM: '0',
  }

  // Start server and verify /api/tree and ~/.zarvis/roster.md suppress ghost1 & ghost2 automatically
  const port = 20000 + Math.floor(Math.random() * 20000)
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...env, ZARVIS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await new Promise((res, rej) => {
      srv.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res())
      srv.on('exit', () => rej(new Error('server exited')))
    })
    const tree = await (await fetch(`http://127.0.0.1:${port}/api/tree`)).json()
    assert.deepEqual(tree.interface.map((i) => i.sessionId), [realIface], 'stale untitled zero-activity interface ghosts hidden from tree')
    assert.deepEqual(tree.interface[0].warnings, [], 'no false multi-interface warning from suppressed ghosts')

    // Wait briefly for writeRoster() at startup to flush roster.md
    let rosterText = ''
    for (let i = 0; i < 20; i++) {
      rosterText = await fsp.readFile(path.join(home, 'roster.md'), 'utf8').catch(() => '')
      if (rosterText) break
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.match(rosterText, /## Interface: Main Zarvis Interface/)
    assert.doesNotMatch(rosterText, /## Interface: Untitled session/)
  } finally {
    srv.kill()
  }

  // Also verify CLI `scripts/role.mjs clear <ghost1>` permanently clears the stale hook tag in state.json
  const cli = spawnSync(process.execPath, [ROLE_SCRIPT, 'clear', ghost1], { env, encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stdout, /cleared role/)
  const state = await readState(path.join(home, 'state.json'))
  assert.equal(state.roles[ghost1].role, 'none')
})
