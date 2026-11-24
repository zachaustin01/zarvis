import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLookup, findEntry, collectRows, cwdsOf, formatLookupEntry } from '../lib/lookup.mjs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runRoster, parseArgs } from '../lib/roster-cli.mjs'

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const NOW = 1_800_000_000_000
const rec = (n, extra = {}) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `Title ${n}`, cwd: `/work/proj${n}`, branch: `br${n}`, lastActivityAt: NOW - 60_000, ...extra })
const IFACE = 1, MGR = 2, W = 3, LONE = 4, PINNED = 5, OLD = 6, ARCH = 7
const noGit = async () => ''

function world(extra = {}) {
  return {
    records: [rec(IFACE), rec(MGR), rec(W), rec(LONE), rec(PINNED), rec(OLD, { lastActivityAt: NOW - 30 * 86400_000 }), rec(ARCH, { isArchived: true })],
    state: { overlays: { [id(MGR)]: { name: 'Hand name' } }, roles: {}, parked: {}, done: {} },
    roles: { [id(IFACE)]: { role: 'interface' }, [id(MGR)]: { role: 'manager' }, [id(W)]: { role: 'worker', parent: id(MGR) }, [id(PINNED)]: { role: 'manager' } },
    markers: [],
    working: [{ sessionId: id(W), at: NOW - 5000, seen: NOW - 5000, state: 'working', cwd: '/work/proj3' }],
    tasks: {},
    now: NOW,
    branchOf: noGit,
    ...extra,
  }
}
const by = (list, n) => list.find((e) => e.sessionId === id(n))

test('a known id resolves to title, overlay name, project, branch and the app id', async () => {
  const list = await buildLookup(world())
  const m = by(list, MGR)
  assert.deepEqual([m.sessionId, m.desktopSessionId, m.title, m.name, m.overlay, m.project, m.branch], [id(MGR), `local_${id(MGR)}`, 'Title 2', 'Hand name', 'Hand name', 'proj2', 'br2'])
})

test('role and parent manager are joined, with the manager named', async () => {
  const w = by(await buildLookup(world()), W)
  assert.deepEqual([w.role, w.managerId, w.managerName], ['worker', id(MGR), 'Hand name'])
  assert.equal(by(await buildLookup(world()), IFACE).role, 'interface')
})

test('a fresh hook marker is live with its state; no signal is unknown, never "not running"', async () => {
  const list = await buildLookup(world())
  const w = by(list, W)
  assert.deepEqual([w.running, w.state], ['live', 'working'])
  assert.equal(w.since, NOW - 5000)
  const m = by(list, MGR)
  assert.deepEqual([m.running, m.state, m.since], ['unknown', 'unknown', 0])
})

test('a stale working marker does not count as live', async () => {
  const list = await buildLookup(world({ working: [{ sessionId: id(W), at: NOW - 3 * 3600_000, seen: NOW - 3 * 3600_000, state: 'working' }] }))
  assert.equal(by(list, W).running, 'unknown')
})

test('a blocked marker is live and blocked', async () => {
  const list = await buildLookup(world({ markers: [{ sessionId: id(W), at: NOW - 1000, seen: NOW - 1000, kind: 'permission', state: 'working', message: 'ok' }] }))
  assert.deepEqual([by(list, W).running, by(list, W).state], ['live', 'blocked'])
})

test('pinned rows: a manager with no signal still appears, as unknown', async () => {
  const p = by(await buildLookup(world()), PINNED)
  assert.deepEqual([p.role, p.running, p.state], ['manager', 'unknown', 'unknown'])
})

test('an unknown id is an error; a local_ id and a unique prefix both resolve', async () => {
  const list = await buildLookup(world())
  assert.match(findEntry(list, 'deadbeef-0000').error, /not a session Zarvis can find/)
  assert.equal(findEntry(list, `local_${id(MGR)}`).entry.sessionId, id(MGR))
  assert.equal(findEntry(list, '22222222').entry.sessionId, id(MGR))
  assert.match(findEntry(list, 'abc').error, /too short/)
  assert.match(findEntry(list, '').error, /no session id/)
})

test('an ambiguous prefix is refused', () => {
  const list = [{ sessionId: 'abcdef01-a', desktopSessionId: 'local_x1' }, { sessionId: 'abcdef01-b', desktopSessionId: 'local_x2' }]
  assert.match(findEntry(list, 'abcdef01').error, /ambiguous/)
})

test('the default list hides old unclassified and archived sessions; --all shows them, archived marked', async () => {
  const list = await buildLookup(world())
  assert.ok(by(list, LONE), 'recent unclassified is listed')
  assert.equal(by(list, OLD), undefined)
  assert.equal(by(list, ARCH), undefined)
  const all = await buildLookup(world({ all: true }))
  assert.equal(by(all, OLD).running, 'unknown')
  assert.equal(by(all, ARCH).running, 'archived')
})

test('interface and managers sort first; parked and done flags carry through', async () => {
  const list = await buildLookup(world({ state: { overlays: {}, roles: {}, parked: { [id(W)]: { parkedAt: NOW, reason: 'x' } }, done: { [id(LONE)]: true } } }))
  assert.deepEqual(list.slice(0, 3).map((e) => e.role), ['interface', 'manager', 'manager'])
  assert.equal(by(list, W).parked, true)
  assert.equal(by(list, LONE).done, true)
})

test('the branch falls back to the checkout when the record has none', async () => {
  const list = await buildLookup(world({ records: [rec(LONE, { branch: '' })], branchOf: async (cwd) => (cwd === '/work/proj4' ? 'from-head' : '') }))
  assert.equal(by(list, LONE).branch, 'from-head')
})

async function cli(args, w = world()) {
  const out = []
  const errs = []
  const code = await runRoster(args, { deps: w, now: NOW, log: (l) => out.push(l), err: (l) => errs.push(l) })
  return { code, out: out.join('\n'), err: errs.join('\n') }
}

test('CLI get --json returns the joined entry; unknown id exits 1', async () => {
  const r = await cli(['get', id(W).slice(0, 8), '--json'], world({ branchOf: noGit }))
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.out).managerName, 'Hand name')
  const bad = await cli(['get', 'ffffffff'])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /not a session Zarvis can find/)
})

test('CLI list filters by role, manager and running; text says unknown honestly', async () => {
  const w = world()
  assert.deepEqual(JSON.parse((await cli(['list', '--role', 'worker', '--json'], w)).out).sessions.map((e) => e.sessionId), [id(W)])
  assert.deepEqual(JSON.parse((await cli(['list', '--manager', id(MGR), '--json'], w)).out).sessions.map((e) => e.sessionId), [id(W)])
  assert.ok(JSON.parse((await cli(['list', '--running', 'archived', '--json'], w)).out).sessions.every((e) => e.running === 'archived'))
  const text = (await cli(['list', '--role', 'manager'], w)).out
  assert.match(text, /Hand name — manager — unknown \(no hook signal/)
  assert.doesNotMatch(text, /not running/)
  assert.match((await cli(['list', '--running', 'bogus'])).err, /--running must be/)
})

test('CLI with no records at all lists nothing, and bad options exit 1', async () => {
  assert.match((await cli(['list'], world({ records: [], roles: {} }))).out, /no matching sessions/)
  assert.equal((await cli(['list', '--bogus'])).code, 1)
  assert.equal((await cli(['nope'])).code, 1)
  assert.throws(() => parseArgs(['list', '--role']), /needs a value/)
})

test('withHolderLinks: a claim\'s holder resolves to its desktop record and claude:// link; no record, or a deleted one, gives no link', async () => {
  const { withHolderLinks } = await import('../lib/lookup.mjs')
  const view = (n) => ({ id: `c${n}`, label: 'K-1', holder: { sessionId: id(n), name: `H${n}`, since: 1, lastWrite: 1 }, shared: [] })
  const records = [rec(W), rec(LONE), rec(ARCH, { isArchived: true })]
  const twin = rec(W, { sessionId: `local_${id(8)}`, isArchived: true, lastActivityAt: NOW }) // an archived twin must not win
  const out = withHolderLinks([view(W), view(MGR), view(LONE), view(ARCH)], [...records, twin], new Set([`local_${id(LONE)}`]))
  assert.equal(out[0].holder.link, `claude://claude.ai/epitaxy/local_${id(W)}`)
  assert.equal(out[1].holder.link, '', 'no desktop record at all')
  assert.equal(out[2].holder.link, '', 'the app deleted it')
  assert.equal(out[3].holder.link, `claude://claude.ai/epitaxy/local_${id(ARCH)}`, 'archived is still openable, as in the lookup')
  assert.equal(out[0].holder.name, 'H3', 'the rest of the view is untouched')
  assert.deepEqual(withHolderLinks([], records), [])
})

test('a classified worker with no record and an aged-out marker still resolves with role and manager', async () => {
  const AGED = 9
  const w = world({ roles: { ...world().roles, [id(AGED)]: { role: 'worker', parent: id(MGR) } } })
  const e = by(await buildLookup({ ...w, all: true }), AGED)
  assert.ok(e)
  assert.deepEqual([e.role, e.managerId, e.managerName], ['worker', id(MGR), 'Hand name'])
})

test('collectRows and buildLookup preserve runtime, project, branch, and manager for aged-out Antigravity and CLI workers (#9)', async () => {
  const prevAgyHome = process.env.ANTIGRAVITY_HOME
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-lookup-agy-'))
  process.env.ANTIGRAVITY_HOME = tmpDir
  try {
    const AGY_WORKER = 8
    const CLI_WORKER = 9
    const agyId = id(AGY_WORKER)
    const cliId = id(CLI_WORKER)

    // Write an Antigravity transcript for AGY_WORKER (subagent/swarm worker shape)
    const trDir = path.join(tmpDir, 'brain', agyId, '.system_generated', 'logs')
    await fsp.mkdir(trDir, { recursive: true })
    const swarmBrief = 'run migrations on analytics db'
    const trLine = JSON.stringify({
      step_index: 0,
      type: 'SYSTEM_MESSAGE',
      content: `sender=${id(MGR)} [swarm] You have just started. Your assignment (recorded on the board as #2 for @worker-2): ${swarmBrief}`,
    })
    await fsp.writeFile(path.join(trDir, 'transcript.jsonl'), trLine + '\n')

    // Both workers have aged-out working/markers (> 24h old)
    const expiredTs = NOW - 24 * 3600_000
    const expiredMarkers = [
      { sessionId: agyId, at: expiredTs, seen: expiredTs, state: 'idle', cwd: '/work/analytics', runtime: 'antigravity' },
      { sessionId: cliId, at: expiredTs, seen: expiredTs, state: 'idle', cwd: '/work/cli-tool', runtime: 'claude' },
    ]

    const w = world({
      roles: {
        ...world().roles,
        [agyId]: { role: 'worker', parent: id(MGR) },
        [cliId]: { role: 'worker', parent: id(MGR) },
      },
      markers: expiredMarkers,
      branchOf: async (cwd) => (cwd.includes('analytics') ? 'develop' : 'feat/cli'),
    })

    // 1. collectRows preserves cwd from expired markers into nodes
    const { nodes, rows } = await collectRows(w)
    assert.equal(rows.some((r) => r.sessionId === agyId), false, 'aged-out marker is not in live queue rows')
    assert.equal(rows.some((r) => r.sessionId === cliId), false)
    assert.equal(nodes.get(agyId)?.cwd, '/work/analytics', 'cwd preserved from expired marker')
    assert.equal(nodes.get(cliId)?.cwd, '/work/cli-tool', 'cwd preserved from expired marker')
    assert.equal(nodes.get(agyId)?.runtime, 'antigravity', 'runtime resolved from transcript')
    assert.equal(nodes.get(cliId)?.runtime, 'claude')

    // 2. buildLookup with all: true includes both aged-out workers with runtime, project, branch, manager
    const list = await buildLookup({ ...w, all: true })
    const agyEntry = list.find((e) => e.sessionId === agyId)
    const cliEntry = list.find((e) => e.sessionId === cliId)

    assert.ok(agyEntry, 'aged-out Antigravity worker present in buildLookup')
    assert.equal(agyEntry.runtime, 'antigravity')
    assert.equal(agyEntry.role, 'worker')
    assert.equal(agyEntry.managerId, id(MGR))
    assert.equal(agyEntry.managerName, 'Hand name')
    assert.equal(agyEntry.project, 'analytics')
    assert.equal(agyEntry.branch, 'develop')
    assert.equal(agyEntry.link, `antigravity://conversation/${agyId}`)

    assert.ok(cliEntry, 'aged-out CLI worker present in buildLookup')
    assert.equal(cliEntry.runtime, 'claude')
    assert.equal(cliEntry.role, 'worker')
    assert.equal(cliEntry.managerId, id(MGR))
    assert.equal(cliEntry.managerName, 'Hand name')
    assert.equal(cliEntry.project, 'cli-tool')
    assert.equal(cliEntry.branch, 'feat/cli')
  } finally {
    if (prevAgyHome === undefined) delete process.env.ANTIGRAVITY_HOME
    else process.env.ANTIGRAVITY_HOME = prevAgyHome
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('formatLookupEntry projects consistent runtime, link, and project fields', () => {
  const state = { overlays: { [id(MGR)]: { name: 'Mgr' } }, parked: {}, done: {} }
  const entry = formatLookupEntry({
    id: id(W),
    title: 'Worker',
    role: 'worker',
    managerId: id(MGR),
    cwd: '/work/api',
    branch: 'main',
    runtime: 'antigravity',
    state,
    projectTags: {},
    links: {},
    schedules: {},
    nameOf: (sid) => state.overlays[sid]?.name || '',
  })
  assert.equal(entry.runtime, 'antigravity')
  assert.equal(entry.link, `antigravity://conversation/${id(W)}`)
  assert.equal(entry.managerName, 'Mgr')
  assert.equal(entry.project, 'api')
  assert.equal(entry.running, 'unknown')
  assert.equal(entry.state, 'unknown')
})
