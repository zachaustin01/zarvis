import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runPark, parseArgs, find } from '../lib/park-cli.mjs'
import { readState, setDone } from '../lib/state.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

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
  assert.match(u.err[1], /^usage: npm run park -- park\|unpark\|done\|undone\|done-children\|list/)
})

test('a manager parks itself once its workers are parked, done or archived; a note is required', async () => {
  const h = await harness()
  const open = await h.run(park(MGR, MGR, ['--note', 'n']))
  assert.equal(open.code, 1)
  assert.match(open.err[0], /still has 1 open worker \(“S3”/)
  assert.match((await h.run(park(MGR, MGR))).err[0], /still has 1 open worker/, 'open workers are named before the note')

  await h.run(park(W, MGR))
  assert.match((await h.run(park(MGR, MGR))).err[0], /--note is required when parking yourself/)
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

test('a worker can park and unpark itself (requiring --note and ignoring own working marker), but never siblings, managers or the interface (#15)', async () => {
  const SIBLING = 7
  const w = world({
    records: [rec(IFACE), rec(MGR), rec(W), rec(SIBLING), rec(OTHER_W), rec(OTHER_MGR), rec(STRAY)],
    roles: {
      [id(IFACE)]: { role: 'interface' },
      [id(MGR)]: { role: 'manager' },
      [id(W)]: { role: 'worker', parent: id(MGR) },
      [id(SIBLING)]: { role: 'worker', parent: id(MGR) },
      [id(OTHER_MGR)]: { role: 'manager' },
      [id(OTHER_W)]: { role: 'worker', parent: id(OTHER_MGR) },
    },
    working: [{ sessionId: id(W), state: 'working', at: NOW - 2000, seen: NOW - 10 }],
    blocked: [{ sessionId: id(W), at: NOW - 1000 }],
  })
  const h = await harness(w)

  // Refuses without --note (or blank --note)
  assert.match((await h.run(park(W, W))).err[0], /--note is required when parking yourself/)
  assert.match((await h.run(park(W, W, ['--note', '   ']))).err[0], /--note is required when parking yourself/)

  // Dry run and real self-park succeed despite active working/blocked markers on W itself
  const dry = await h.run(park(W, W, ['--note', 'Done: fix; Branch: fix/15', '--dry-run']))
  assert.equal(dry.code, 0)
  assert.match(dry.out[0], /^would park “S3”/)
  await assert.rejects(fsp.access(h.stateFile))

  const ok = await h.run(park(W, W, ['--note', 'Done: fix; Branch: fix/15']))
  assert.equal(ok.code, 0)
  assert.match(ok.out[0], /^parked “S3”/)
  const p = (await readState(h.stateFile)).parked[id(W)]
  assert.deepEqual([p.parkedBy, p.reason, p.handoffNote], [id(W), 'finished', 'Done: fix; Branch: fix/15'])

  // Worker can list and unpark itself
  const listed = await h.run(['list', '--by', id(W)])
  assert.equal(listed.out.length, 1)
  assert.match(listed.out[0], /S3 .*by S3 — finished/)
  assert.match((await h.run(['unpark', id(W), '--by', id(W)])).out[0], /^unparked “S3”/)
  assert.deepEqual((await readState(h.stateFile)).parked, {})

  // Worker cannot park/unpark sibling, other worker, manager, stray or interface; interface still cannot park anyone
  for (const [args, msg] of [
    [park(SIBLING, W, ['--note', 'n']), /is a worker; a worker may only act on itself/],
    [park(OTHER_W, W, ['--note', 'n']), /is a worker; a worker may only act on itself/],
    [park(MGR, W, ['--note', 'n']), /is a worker; a worker may only act on itself/],
    [park(STRAY, W, ['--note', 'n']), /is a worker; a worker may only act on itself/],
    [park(IFACE, W, ['--note', 'n']), /interface session/],
    [['unpark', id(SIBLING), '--by', id(W)], /is a worker; a worker may only act on itself/],
    [park(MGR, IFACE), /not a manager/],
    [park(IFACE, IFACE), /not a manager/],
  ]) {
    const r = await h.run(args)
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.err[0], msg)
  }
})

test('done and undone mark sessions done, clear parked entries, enforce busy/ownership rules, and support --dry-run (#15)', async () => {
  const SIBLING = 7
  const makeWorld = (extra = {}) =>
    world({
      records: [rec(IFACE), rec(MGR), rec(W), rec(SIBLING), rec(OTHER_W), rec(OTHER_MGR), rec(STRAY)],
      roles: {
        [id(IFACE)]: { role: 'interface' },
        [id(MGR)]: { role: 'manager' },
        [id(W)]: { role: 'worker', parent: id(MGR) },
        [id(SIBLING)]: { role: 'worker', parent: id(MGR) },
        [id(OTHER_MGR)]: { role: 'manager' },
        [id(OTHER_W)]: { role: 'worker', parent: id(OTHER_MGR) },
      },
      ...extra,
    })

  // Busy worker refused without --force; allowed with --force
  const busyH = await harness(makeWorld({ working: [{ sessionId: id(W), state: 'working', at: NOW - 1000, seen: NOW - 1000 }] }))
  const refusedBusy = await busyH.run(['done', id(W), '--by', id(MGR)])
  assert.equal(refusedBusy.code, 1)
  assert.match(refusedBusy.err[0], /is working/)
  assert.equal((await busyH.run(['done', id(W), '--by', id(MGR), '--force'])).code, 0)
  assert.equal((await readState(busyH.stateFile)).done[id(W)], true)

  // Park first, then dry-run done, then real done un-parks and marks done
  const h = await harness(makeWorld({ working: [{ sessionId: id(SIBLING), state: 'working', at: NOW - 1000, seen: NOW - 10 }] }))
  await h.run(park(W, MGR))
  assert.ok((await readState(h.stateFile)).parked[id(W)])

  const dryDone = await h.run(['done', id(W), '--by', id(MGR), '--dry-run'])
  assert.equal(dryDone.code, 0)
  assert.match(dryDone.out[0], /^would mark done “S3”/)
  assert.equal((await readState(h.stateFile)).done[id(W)], undefined)
  assert.ok((await readState(h.stateFile)).parked[id(W)])

  const didDone = await h.run(['done', id(W), '--by', id(MGR)])
  assert.equal(didDone.code, 0)
  assert.match(didDone.out[0], /^marked done “S3”/)
  const afterDone = await readState(h.stateFile)
  assert.equal(afterDone.done[id(W)], true)
  assert.equal(afterDone.parked[id(W)], undefined, 'done deletes parked entry')

  // Worker marks itself done despite its own working marker; cannot mark sibling or manager done
  assert.equal((await h.run(['done', id(W), '--by', id(SIBLING)])).code, 1)
  assert.equal((await h.run(['done', id(MGR), '--by', id(SIBLING)])).code, 1)
  const selfDone = await h.run(['done', id(SIBLING), '--by', id(SIBLING)])
  assert.equal(selfDone.code, 0)
  assert.equal((await readState(h.stateFile)).done[id(SIBLING)], true)

  // Manager marks itself done once all workers are closed (refused while open unless --force)
  const mgrOpen = await harness(makeWorld())
  assert.match((await mgrOpen.run(['done', id(MGR), '--by', id(MGR)])).err[0], /still has 2 open workers/)
  assert.equal((await h.run(['done', id(MGR), '--by', id(MGR)])).code, 0)
  assert.equal((await readState(h.stateFile)).done[id(MGR)], true)

  // undone: dry-run, real run, already not done, and ownership refusal
  assert.equal((await h.run(['undone', id(W), '--by', id(OTHER_MGR)])).code, 1)
  assert.equal((await h.run(['undone', id(W), '--by', id(SIBLING)])).code, 1)
  const dryUndone = await h.run(['undone', id(W), '--by', id(MGR), '--dry-run'])
  assert.equal(dryUndone.code, 0)
  assert.match(dryUndone.out[0], /^would unmark done “S3”/)
  assert.equal((await readState(h.stateFile)).done[id(W)], true)

  const didUndone = await h.run(['undone', id(W), '--by', id(MGR)])
  assert.equal(didUndone.code, 0)
  assert.match(didUndone.out[0], /^unmarked done “S3”/)
  assert.equal((await readState(h.stateFile)).done[id(W)], undefined)

  const notDone = await h.run(['undone', id(W), '--by', id(MGR)])
  assert.equal(notDone.code, 0)
  assert.match(notDone.out[0], /“S3” .* is not marked done/)

  // Worker can also undone itself
  assert.equal((await h.run(['undone', id(SIBLING), '--by', id(SIBLING)])).code, 0)
  assert.equal((await readState(h.stateFile)).done[id(SIBLING)], undefined)
})

test('done-children marks a manager\'s open and parked workers done, refuses busy ones without --force, and supports --dry-run (#15)', async () => {
  const W2 = 7
  const makeWorld = (extra = {}) =>
    world({
      records: [rec(IFACE), rec(MGR), rec(W), rec(W2), rec(OTHER_W), rec(OTHER_MGR), rec(STRAY)],
      roles: {
        [id(IFACE)]: { role: 'interface' },
        [id(MGR)]: { role: 'manager' },
        [id(W)]: { role: 'worker', parent: id(MGR) },
        [id(W2)]: { role: 'worker', parent: id(MGR) },
        [id(OTHER_MGR)]: { role: 'manager' },
        [id(OTHER_W)]: { role: 'worker', parent: id(OTHER_MGR) },
      },
      ...extra,
    })

  // Refuses non-managers, missing --by, or unexpected positional arg
  const base = await harness(makeWorld())
  assert.equal((await base.run(['done-children'])).code, 1)
  assert.match((await base.run(['done-children', '--by', id(W)])).err[0], /not a manager/)
  assert.match((await base.run(['done-children', id(W), '--by', id(MGR)])).err[0], /unexpected argument/)

  // Refuses when any child is blocked or working unless --force
  const busy = await harness(makeWorld({ blocked: [{ sessionId: id(W2), at: NOW - 500 }] }))
  const refused = await busy.run(['done-children', '--by', id(MGR)])
  assert.equal(refused.code, 1)
  assert.match(refused.err[0], /still has 1 busy worker \(“S7” .* is blocked\)/)
  await assert.rejects(fsp.access(busy.stateFile))
  assert.equal((await busy.run(['done-children', '--by', id(MGR), '--force'])).code, 0)
  assert.deepEqual(Object.keys((await readState(busy.stateFile)).done).sort(), [id(W), id(W2)].sort())

  // Park W, leave W2 open; dry-run changes nothing; real run marks both done (and unparks W), leaving OTHER_W untouched
  await base.run(park(W, MGR))
  const dry = await base.run(['done-children', '--by', id(MGR), '--dry-run'])
  assert.equal(dry.code, 0)
  assert.match(dry.out[0], /^would mark 2 workers done \(“S3” .*, “S7” .*\)/)
  assert.deepEqual((await readState(base.stateFile)).done, {})
  assert.ok((await readState(base.stateFile)).parked[id(W)])

  const ran = await base.run(['done-children', '--by', id(MGR)])
  assert.equal(ran.code, 0)
  assert.match(ran.out[0], /^marked 2 workers done \(“S3” .*, “S7” .*\)/)
  const st = await readState(base.stateFile)
  assert.deepEqual(st.done, { [id(W)]: true, [id(W2)]: true })
  assert.deepEqual(st.parked, {})

  // Running again when all children are already done prints empty message and exits 0
  const empty = await base.run(['done-children', '--by', id(MGR)])
  assert.equal(empty.code, 0)
  assert.equal(empty.out[0], 'no open workers to mark done')
})

test('recognizes Antigravity sessions via world.sessions in runPark and via scanAntigravitySessions in liveDeps (#15)', async () => {
  const AGY_MGR = 8
  const AGY_W = 9
  const w = {
    records: [],
    sessions: [
      { sessionId: id(AGY_MGR), title: 'Agy Coordinator', cwd: '/r/agy', runtime: 'antigravity' },
      { sessionId: id(AGY_W), title: 'Agy Worker', cwd: '/r/agy-wt', runtime: 'antigravity' },
    ],
    roles: {
      [id(AGY_MGR)]: { role: 'manager' },
      [id(AGY_W)]: { role: 'worker', parent: id(AGY_MGR) },
    },
    blocked: [],
    working: [{ sessionId: id(AGY_W), state: 'idle', cwd: '/r/agy-wt-fresh', at: NOW - 5000, seen: NOW - 5000 }],
  }
  const h = await harness(w)

  // find() never matches empty desktopSessionId against an empty query
  assert.equal(find(new Map([[id(AGY_W), { sessionId: id(AGY_W), desktopSessionId: '' }]]), ''), undefined)

  // Antigravity worker self-parks using its Antigravity title
  const selfPark = await h.run(['park', id(AGY_W), '--by', id(AGY_W), '--reason', 'user approved', '--note', 'merged'])
  assert.equal(selfPark.code, 0)
  assert.match(selfPark.out[0], /^parked “Agy Worker”/)

  const listOut = await h.run(['list', '--by', id(AGY_MGR)])
  assert.equal(listOut.out.length, 1)
  assert.match(listOut.out[0], /Agy Worker .*by Agy Worker — user approved · note: merged/)

  // Antigravity manager marks children done and then marks itself done
  const dc = await h.run(['done-children', '--by', id(AGY_MGR)])
  assert.equal(dc.code, 0)
  assert.match(dc.out[0], /^marked 1 worker done \(“Agy Worker”/)
  assert.equal((await h.run(['done', id(AGY_MGR), '--by', id(AGY_MGR)])).code, 0)
  assert.deepEqual((await readState(h.stateFile)).done, { [id(AGY_W)]: true, [id(AGY_MGR)]: true })

  // Isolated child-process check of liveDeps() + scripts/park.mjs against temp dirs only
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-park-live-'))
  try {
    const fakeHome = path.join(tmpRoot, 'home')
    const zarvisHome = path.join(tmpRoot, 'zarvis')
    const desktopDir = path.join(tmpRoot, 'desktop')
    const agyHome = path.join(tmpRoot, 'agy')
    const trDir = path.join(agyHome, 'brain', id(AGY_W), '.system_generated', 'logs')
    await fsp.mkdir(trDir, { recursive: true })
    await fsp.mkdir(path.join(zarvisHome, 'roles'), { recursive: true })
    await fsp.mkdir(desktopDir, { recursive: true })
    await fsp.mkdir(fakeHome, { recursive: true })
    await fsp.writeFile(
      path.join(trDir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Ship issue 15</USER_REQUEST>' }) + '\n',
    )
    await fsp.writeFile(
      path.join(zarvisHome, 'roles', `${id(AGY_W)}.json`),
      JSON.stringify({ sessionId: id(AGY_W), role: 'worker', parent: id(AGY_MGR), at: NOW }),
    )

    const env = {
      ...process.env,
      HOME: fakeHome,
      ZARVIS_HOME: zarvisHome,
      ZARVIS_DESKTOP_SESSIONS: desktopDir,
      ANTIGRAVITY_HOME: agyHome,
    }
    const probe = await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        ['--input-type=module', '-e', 'import { liveDeps } from "./lib/park-cli.mjs"; console.log(JSON.stringify(await liveDeps()))'],
        { cwd: ROOT, env },
        (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))),
      ),
    )
    const found = probe.sessions.find((s) => s.sessionId === id(AGY_W))
    assert.ok(found, 'liveDeps() includes scanned Antigravity session')
    assert.equal(found.title, 'Ship issue 15')

    const cli = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [path.join(ROOT, 'scripts', 'park.mjs'), 'park', id(AGY_W), '--by', id(AGY_W), '--reason', 'shipped', '--note', 'verified npm test'],
        { cwd: ROOT, env },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
      ),
    )
    assert.equal(cli.code, 0, cli.stderr)
    assert.match(cli.stdout, /parked “Ship issue 15”/)
    const diskState = await readState(path.join(zarvisHome, 'state.json'))
    assert.equal(diskState.parked[id(AGY_W)].parkedBy, id(AGY_W))
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
})
