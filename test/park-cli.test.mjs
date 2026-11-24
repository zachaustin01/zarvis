import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runPark, parseArgs } from '../lib/park-cli.mjs'
import { readState, setDone } from '../lib/state.mjs'

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const rec = (n, extra = {}) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `S${n}`, cwd: `/r/${n}`, ...extra })
const NOW = 1_800_000_000_000
const IFACE = 1, MGR = 2, W = 3, OTHER_W = 4, OTHER_MGR = 5, STRAY = 6

function world(extra = {}) {
  return {
    records: [rec(IFACE), rec(MGR), rec(W), rec(OTHER_W), rec(OTHER_MGR), rec(STRAY)],
    roles: {
      [id(IFACE)]: { role: 'interface' },
      [id(MGR)]: { role: 'manager' },
      [id(W)]: { role: 'worker', parent: id(MGR) },
      [id(OTHER_MGR)]: { role: 'manager' },
      [id(OTHER_W)]: { role: 'worker', parent: id(OTHER_MGR) },
    },
    blocked: [],
    working: [],
    ...extra,
  }
}

async function harness(w = world()) {
  const stateFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-park-')), 'state.json')
  const out = []
  const errs = []
  const run = async (args) => ({ code: await runPark(args, { deps: w, stateFile, now: NOW, log: (l) => out.push(l), err: (l) => errs.push(l) }), out: out.splice(0), err: errs.splice(0) })
  return { stateFile, run }
}
const park = (target, by, more = []) => ['park', id(target), '--by', id(by), '--reason', 'finished', ...more]

test('parseArgs reads flags and rejects unknown ones', () => {
  const a = parseArgs(['park', 'x', '--by', 'm', '--reason', 'r', '--force', '--dry-run'])
  assert.deepEqual([a.cmd, a.id, a.by, a.reason, a.force, a.dryRun], ['park', 'x', 'm', 'r', true, true])
  assert.throws(() => parseArgs(['park', '--bogus']), /unknown option/)
  assert.throws(() => parseArgs(['park', 'x', '--by']), /needs a value/)
})

test('a manager parks its own idle worker; the entry records who and why', async () => {
  const h = await harness()
  const r = await h.run(park(W, MGR, ['--note', 'PR 7 merged', '--wake', '2026-12-01']))
  assert.equal(r.code, 0)
  assert.equal(r.out.length, 1)
  assert.match(r.out[0], /^parked “S3”/)
  const p = (await readState(h.stateFile)).parked[id(W)]
  assert.deepEqual([p.parkedBy, p.reason, p.handoffNote, p.wake, p.parkedAt], [id(MGR), 'finished', 'PR 7 merged', { type: 'date', value: '2026-12-01' }, NOW])
})

test('the app\'s local_… id works for the session and for --by', async () => {
  const h = await harness()
  const r = await h.run(['park', `local_${id(W)}`, '--by', `local_${id(MGR)}`, '--reason', 'x'])
  assert.equal(r.code, 0)
  assert.equal((await readState(h.stateFile)).parked[id(W)].parkedBy, id(MGR), 'stored by CLI id')
})

test('refuses the interface, managers, other managers\' workers, strays and non-managers as --by', async () => {
  const h = await harness()
  for (const [args, msg] of [
    [park(IFACE, MGR), /interface session/],
    [park(OTHER_MGR, MGR), /another manager/],
    [park(OTHER_W, MGR), /not a worker of/],
    [park(STRAY, MGR), /not a worker of/],
    [park(W, STRAY), /not a manager/],
    [park(W, IFACE), /not a manager/],
    [park(W, 9), /not a live session/],
  ]) {
    const r = await h.run(args)
    assert.equal(r.code, 1, args.join(' '))
    assert.equal(r.err.length, 1)
    assert.match(r.err[0], msg)
  }
  assert.deepEqual((await readState(h.stateFile)).parked, {})
})

test('--by is required and ids must be plain', async () => {
  const h = await harness()
  assert.match((await h.run(['park', id(W), '--reason', 'x'])).err[0], /--by must be/)
  assert.match((await h.run(['park', '../x', '--by', id(MGR), '--reason', 'x'])).err[0], /bad session id/)
  assert.match((await h.run(['park', id(W), '--by', 'a b', '--reason', 'x'])).err[0], /--by must be/)
  assert.match((await h.run(['park', id(W), '--by', id(MGR)])).err[0], /--reason is required/)
  assert.match((await h.run(['park', id(W), '--by', id(MGR), '--reason', 'x', '--wake', 'soon'])).err[0], /YYYY-MM-DD/)
  assert.equal((await h.run(['frobnicate'])).code, 1)
})

test('refuses a blocked or working worker unless --force; idle and stale markers are fine', async () => {
  const w = world({
    blocked: [{ sessionId: id(W), at: NOW - 1000 }],
  })
  const h = await harness(w)
  const r = await h.run(park(W, MGR))
  assert.equal(r.code, 1)
  assert.match(r.err[0], /is blocked/)
  assert.equal((await h.run(park(W, MGR, ['--force']))).code, 0)

  const busy = await harness(world({ working: [{ sessionId: id(W), state: 'working', at: NOW - 5000, seen: NOW - 5000 }] }))
  assert.match((await busy.run(park(W, MGR))).err[0], /is working/)

  const calm = await harness(world({ working: [{ sessionId: id(W), state: 'idle', at: NOW - 5000, seen: NOW - 5000 }], blocked: [{ sessionId: id(W), at: NOW - 13 * 3600 * 1000 }] }))
  assert.equal((await calm.run(park(W, MGR))).code, 0, 'idle and long-stale markers do not block')
  const quiet = await harness(world({ working: [{ sessionId: id(W), state: 'working', at: NOW - 3600e3, seen: NOW - 3600e3 }] }))
  assert.equal((await quiet.run(park(W, MGR))).code, 0, 'a working marker quiet for an hour is stale')
})

test('--dry-run changes nothing but validates like the real thing', async () => {
  const h = await harness()
  const r = await h.run(park(W, MGR, ['--dry-run']))
  assert.equal(r.code, 0)
  assert.match(r.out[0], /^would park/)
  await assert.rejects(fsp.access(h.stateFile))
  assert.equal((await h.run(park(W, MGR, ['--dry-run', '--wake', 'nope']))).code, 1)
  assert.equal((await h.run(park(OTHER_W, MGR, ['--dry-run']))).code, 1)
})

test('re-parking is idempotent: one entry, updated in place', async () => {
  const h = await harness()
  await h.run(park(W, MGR))
  const r = await h.run(['park', id(W), '--by', id(MGR), '--reason', 'newer reason'])
  assert.match(r.out[0], /^re-parked/)
  const s = await readState(h.stateFile)
  assert.deepEqual(Object.keys(s.parked), [id(W)])
  assert.equal(s.parked[id(W)].reason, 'newer reason')
})

test('unpark clears it, tolerates not-parked, and obeys the same ownership rules', async () => {
  const h = await harness()
  await h.run(park(W, MGR))
  assert.equal((await h.run(['unpark', id(W), '--by', id(OTHER_MGR)])).code, 1)
  assert.equal((await readState(h.stateFile)).parked[id(W)].reason, 'finished', 'not touched by the wrong manager')
  assert.equal((await h.run(['unpark', id(W), '--by', id(MGR), '--dry-run'])).out[0].startsWith('would unpark'), true)
  assert.ok((await readState(h.stateFile)).parked[id(W)])
  assert.match((await h.run(['unpark', id(W), '--by', id(MGR)])).out[0], /^unparked/)
  assert.deepEqual((await readState(h.stateFile)).parked, {})
  const again = await h.run(['unpark', id(W), '--by', id(MGR)])
  assert.equal(again.code, 0)
  assert.match(again.out[0], /not parked/)
})

test('parking an already-done session un-dones it; other state is kept', async () => {
  const h = await harness()
  await setDone(id(W), true, h.stateFile)
  await h.run(park(W, MGR))
  const s = await readState(h.stateFile)
  assert.equal(s.done[id(W)], undefined)
  assert.ok(s.parked[id(W)])
})

test('list shows parked sessions, optionally for one manager', async () => {
  const h = await harness()
  await h.run(park(W, MGR, ['--note', 'first line\nsecond']))
  await h.run(park(OTHER_W, OTHER_MGR))
  const all = await h.run(['list'])
  assert.equal(all.out.length, 2)
  const mine = await h.run(['list', '--by', id(MGR)])
  assert.equal(mine.out.length, 1)
  assert.match(mine.out[0], /S3 .*by S2 — finished · note: first line$/)
  assert.equal((await (await harness()).run(['list'])).out[0], 'nothing parked')
})

test('an impossible wake date is refused by the CLI, dry run or not; unknown command is one line plus usage', async () => {
  const h = await harness()
  for (const extra of [[], ['--dry-run']]) {
    const r = await h.run(park(W, MGR, ['--wake', '2026-02-31', ...extra]))
    assert.equal(r.code, 1)
    assert.match(r.err[0], /YYYY-MM-DD/)
  }
  await assert.rejects(fsp.access(h.stateFile))
  const u = await h.run(['frobnicate'])
  assert.equal(u.code, 1)
  assert.equal(u.err.length, 2)
  assert.ok(u.err.every((l) => !l.includes('\n')))
  assert.match(u.err[0], /^park: unknown command frobnicate$/)
  assert.match(u.err[1], /^usage: npm run park -- park\|unpark\|list/)
})

test('a manager parks itself once its workers are parked, done or archived; a note is required', async () => {
  const h = await harness()
  const open = await h.run(park(MGR, MGR, ['--note', 'n']))
  assert.equal(open.code, 1)
  assert.match(open.err[0], /still has 1 open worker \(“S3”/)
  assert.match((await h.run(park(MGR, MGR))).err[0], /still has 1 open worker/, 'open workers are named before the note')

  await h.run(park(W, MGR))
  assert.match((await h.run(park(MGR, MGR))).err[0], /--note is required when a manager parks itself/)
  assert.match((await h.run(park(MGR, MGR, ['--note', '  ']))).err[0], /--note is required/)
  assert.match((await h.run(park(MGR, MGR, ['--note', 'PRs 1-3 merged', '--dry-run']))).out[0], /^would park “S2”/)
  const r = await h.run(park(MGR, MGR, ['--note', 'PRs 1-3 merged']))
  assert.equal(r.code, 0)
  const p = (await readState(h.stateFile)).parked[id(MGR)]
  assert.deepEqual([p.parkedBy, p.handoffNote], [id(MGR), 'PRs 1-3 merged'])
  assert.match((await h.run(['unpark', id(MGR), '--by', id(MGR)])).out[0], /^unparked “S2”/)
})

test('self-park counts done and archived workers as finished, and --force overrides open ones', async () => {
  const done = await harness()
  await setDone(id(W), true, done.stateFile)
  assert.equal((await done.run(park(MGR, MGR, ['--note', 'n']))).code, 0)

  const archived = await harness(world({ records: [rec(IFACE), rec(MGR), rec(W, { isArchived: true }), rec(OTHER_W), rec(OTHER_MGR), rec(STRAY)] }))
  assert.equal((await archived.run(park(MGR, MGR, ['--note', 'n']))).code, 0)

  const forced = await harness()
  assert.equal((await forced.run(park(MGR, MGR, ['--note', 'n', '--force']))).code, 0)
})

test('self-park ignores the manager\'s own working marker (it is mid-turn); its blocked one too', async () => {
  const h = await harness(world({ working: [{ sessionId: id(MGR), state: 'working', at: NOW - 5000, seen: NOW - 10 }] }))
  await h.run(park(W, MGR))
  assert.equal((await h.run(park(MGR, MGR, ['--note', 'n']))).code, 0)
})

test('a worker cannot park its manager or itself; the interface still cannot park anyone', async () => {
  const h = await harness()
  assert.match((await h.run(park(MGR, W))).err[0], /not a manager/)
  assert.match((await h.run(park(W, W))).err[0], /not a manager/)
  assert.match((await h.run(park(MGR, IFACE))).err[0], /not a manager/)
  assert.match((await h.run(park(IFACE, IFACE))).err[0], /not a manager/)
})
