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
})
