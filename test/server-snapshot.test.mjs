import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-snap-'))

test('server: /api/tree sets runtime and link on archived parked sessions, and /api/queue works with unified tick snapshot', async () => {
  const home = await tmp()
  const desktop = await tmp()
  const cliId = '11111111-1111-4111-8111-111111111111'
  const deskId = 'local_11111111-1111-4111-8111-111111111111'

  const desktopOrg = path.join(desktop, 'acct', 'org')
  await fsp.mkdir(desktopOrg, { recursive: true })
  await fsp.writeFile(
    path.join(desktopOrg, `${deskId}.json`),
    JSON.stringify({
      sessionId: deskId,
      cliSessionId: cliId,
      title: 'Archived parked session',
      cwd: '/tmp/repo',
      branch: 'feat/test',
      isArchived: true,
      lastActivityAt: Date.now() - 60_000,
    }),
  )
  await fsp.writeFile(
    path.join(home, 'state.json'),
    JSON.stringify({
      overlays: {},
      roles: {},
      parked: {
        [cliId]: { reason: 'waiting on review', parkedAt: Date.now() - 10_000, wake: null, handoffNote: '' },
      },
      done: {},
    }),
  )

  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      ZARVIS_HOME: home,
      ZARVIS_PORT: String(port),
      ZARVIS_DESKTOP_SESSIONS: desktop,
      ZARVIS_DRY_OPEN: '1',
      ZARVIS_COSTS_WARM: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  try {
    await new Promise((res, rej) => {
      p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res())
      p.on('exit', () => rej(new Error('server exited')))
    })
    const base = `http://127.0.0.1:${port}`

    const qRes = await fetch(`${base}/api/queue`)
    assert.equal(qRes.status, 200)
    const q = await qRes.json()
    assert.ok(Array.isArray(q.queue))
    assert.ok(Array.isArray(q.claims))
    assert.ok(Array.isArray(q.events))
    assert.equal(q.hook.status, 'absent')

    const tRes = await fetch(`${base}/api/tree`)
    assert.equal(tRes.status, 200)
    const tree = await tRes.json()
    assert.equal(tree.archived.length, 1)
    assert.equal(tree.archived[0].sessionId, cliId)
    assert.equal(tree.archived[0].runtime, 'claude')
    assert.equal(tree.archived[0].link, `claude://claude.ai/epitaxy/${deskId}`)
  } finally {
    p.kill()
  }
})

test('server.mjs: tick() uses a single readWorldSnapshot() and archivedParked handles antigravity runtime', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'server.mjs'), 'utf8')
  const tickMatch = src.match(/async function tick\(\)\s*\{[\s\S]*?\n\}/)
  assert.ok(tickMatch, 'tick() exists')
  const tickBody = tickMatch[0]
  assert.match(tickBody, /readWorldSnapshot\(\)/)
  assert.doesNotMatch(tickBody, /readMarkers\(/)
  assert.doesNotMatch(tickBody, /scanDesktopRecords\(/)
  assert.doesNotMatch(tickBody, /readState\(/)

  assert.match(src, /runtime:\s*n\.runtime\s*\|\|\s*'claude'/)
  assert.match(src, /n\.runtime === 'antigravity'\s*\?\s*`antigravity:\/\/conversation\/\$\{n\.sessionId\}`\s*:\s*deepLinkFor\(n\.desktopSessionId\)/)
  assert.match(src, /const agyMeta = enrichAgyMeta\(\{ records, roles, sessions: queue, cwds: allCwds \}\)/)
  assert.match(src, /classify\(\{ records, roles, cwds: allCwds, sessions: queue, agyMeta \}\)/)
})

test('server: /api/tree enriches aged-out Antigravity role-only workers with title and antigravity runtime', async () => {
  const home = await tmp()
  const desktop = await tmp()
  const agy = await tmp()
  const mgrId = '22222222-2222-4222-8222-222222222222'
  const workerId = '33333333-3333-4333-8333-333333333333'

  await fsp.mkdir(path.join(home, 'roles'), { recursive: true })
  await fsp.writeFile(path.join(home, 'roles', `${mgrId}.json`), JSON.stringify({ sessionId: mgrId, role: 'manager', parent: '' }))
  await fsp.writeFile(path.join(home, 'roles', `${workerId}.json`), JSON.stringify({ sessionId: workerId, role: 'worker', parent: mgrId }))
  await fsp.mkdir(path.join(agy, 'annotations'), { recursive: true })
  await fsp.writeFile(path.join(agy, 'annotations', `${mgrId}.pbtxt`), 'title:"Strategy Manager"')
  await fsp.mkdir(path.join(agy, 'brain', workerId, '.system_generated', 'logs'), { recursive: true })
  await fsp.writeFile(
    path.join(agy, 'brain', workerId, '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({
      type: 'SYSTEM_MESSAGE',
      content: `[Message] sender=${mgrId} content=You have just started. Your assignment (recorded on the board as #1 for @accuracy): Evaluate accuracy`,
    }) + '\n',
  )

  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      ZARVIS_HOME: home,
      ZARVIS_PORT: String(port),
      ZARVIS_DESKTOP_SESSIONS: desktop,
      ANTIGRAVITY_HOME: agy,
      ZARVIS_DRY_OPEN: '1',
      ZARVIS_COSTS_WARM: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  try {
    await new Promise((res, rej) => {
      p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res())
      p.on('exit', () => rej(new Error('server exited')))
    })
    const tRes = await fetch(`http://127.0.0.1:${port}/api/tree`)
    assert.equal(tRes.status, 200)
    const tree = await tRes.json()
    const mgr = tree.managers.find((m) => m.sessionId === mgrId)
    assert.ok(mgr, 'manager present in /api/tree')
    assert.equal(mgr.runtime, 'antigravity')
    assert.equal(mgr.children.length, 1)
    assert.equal(mgr.children[0].sessionId, workerId)
    assert.equal(mgr.children[0].runtime, 'antigravity')
    assert.equal(mgr.children[0].title, '@accuracy: Evaluate accuracy')
  } finally {
    p.kill()
    await Promise.all([
      fsp.rm(home, { recursive: true, force: true }).catch(() => {}),
      fsp.rm(desktop, { recursive: true, force: true }).catch(() => {}),
      fsp.rm(agy, { recursive: true, force: true }).catch(() => {}),
    ])
  }
})
