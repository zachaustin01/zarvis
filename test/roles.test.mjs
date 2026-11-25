import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { classify, childrenOf, NO_ROLE, roleMarker, rolePrompt, isNewSessionRole } from '../lib/roles.mjs'
import { renderRoster, visibleInterfaces, isGhostInterface } from '../lib/roster.mjs'
import { applyRoles, newSessionLink } from '../lib/queue.mjs'
import { setRole, readState } from '../lib/state.mjs'
import { buildRoleTag, spawnsWorker } from '../hooks/zarvis-hook.mjs'
import { spawnSync } from 'node:child_process'
import { runPark } from '../lib/park-cli.mjs'
import { buildLookup } from '../lib/lookup.mjs'

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const rec = (n, extra = {}) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `S${n}`, cwd: `/r/${n}`, ...extra })
const spawnedBy = (n) => ({ spawnedFrom: { sessionId: `local_${id(n)}` } })

test('explicit tags win; a worker spawned by a tagged manager attaches to it', () => {
  const nodes = classify({ records: [rec(1), rec(2), rec(3, spawnedBy(2))], roles: { [id(1)]: { role: 'interface' }, [id(2)]: { role: 'manager' } } })
  assert.equal(nodes.get(id(1)).role, 'interface')
  assert.equal(nodes.get(id(3)).role, 'worker')
  assert.equal(nodes.get(id(3)).managerId, id(2))
  assert.deepEqual(childrenOf(nodes).get(id(2)).map((n) => n.sessionId), [id(3)])
})

test('spawn links from the interface are ignored; a spawner is only suggested as manager', () => {
  const nodes = classify({ records: [rec(1), rec(2, spawnedBy(1)), rec(3), rec(4, spawnedBy(3))], roles: { [id(1)]: { role: 'interface' } } })
  assert.equal(nodes.get(id(2)).role, 'unclassified', 'spawned by the interface: not a worker')
  assert.equal(nodes.get(id(3)).role, 'unclassified')
  assert.equal(nodes.get(id(3)).suggested, 'manager')
  assert.equal(nodes.get(id(4)).role, 'unclassified', 'its parent is not a confirmed manager yet')
})

test('archived sessions are left out and invariants warn without blocking', () => {
  const nodes = classify({
    records: [rec(1), rec(2), rec(3, { isArchived: true }), rec(4)],
    roles: { [id(1)]: { role: 'interface' }, [id(2)]: { role: 'interface' }, [id(4)]: { role: 'manager', parent: id(1) } },
  })
  assert.equal(nodes.has(id(3)), false)
  assert.match(nodes.get(id(1)).warnings[0], /more than one interface/)
  assert.match(nodes.get(id(4)).warnings[0], /no manager/)
})

test('a manager with a blocked worker rolls up as waiting_on_child, never as needs-you', () => {
  const nodes = classify({ records: [rec(2), rec(3, spawnedBy(2))], roles: { [id(2)]: { role: 'manager' } } })
  const row = (n, state) => ({ sessionId: id(n), state, since: 1, name: `S${n}`, prompt: 'p' })
  const out = applyRoles([row(2, 'working'), row(3, 'blocked')], nodes)
  assert.deepEqual(out.map((r) => [r.sessionId, r.state]), [[id(3), 'blocked'], [id(2), 'waiting_on_child']])
  assert.equal(out[1].blockedChildren[0].sessionId, id(3))
  assert.equal(out[0].role, 'worker')
})

test('registry: setRole stores a worker parent, clears on empty, rejects bad roles', async () => {
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-')), 'state.json')
  await setRole(id(3), 'worker', id(2), file)
  assert.equal((await readState(file)).roles[id(3)].parent, id(2))
  await setRole(id(3), '', '', file)
  assert.deepEqual((await readState(file)).roles, {})
  await assert.rejects(setRole(id(3), 'boss', '', file), /bad role/)
})

test('hook reads a role marker from the start of the prompt', () => {
  assert.deepEqual(buildRoleTag({ session_id: id(2), prompt: '[zarvis: role=Manager] Hi' }, 5), { sessionId: id(2), role: 'manager', parent: '', at: 5 })
  assert.equal(buildRoleTag({ session_id: id(3), prompt: `[zarvis: role=worker parent=${id(2)}]` }).parent, id(2))
  assert.equal(buildRoleTag({ session_id: id(3), prompt: 'no marker' }), null)
})

test('hook skips leading system-reminder blocks before the role tag', () => {
  const rem = '<system-reminder>\nscratch workspace [zarvis: role=worker]\n</system-reminder>'
  const tag = (prompt) => buildRoleTag({ session_id: id(2), prompt }, 1)
  const want = { sessionId: id(2), role: 'interface', parent: '', at: 1 }
  assert.deepEqual(tag('[zarvis: role=interface] go'), want)
  assert.deepEqual(tag(`${rem}[zarvis: role=interface] go`), want)
  assert.deepEqual(tag(`${rem}\n\n[zarvis: role=interface] go`), want)
  assert.deepEqual(tag(`${rem}\n${rem}\n\n  [zarvis: role=interface] go`), want)
  assert.deepEqual(tag(`\n${rem}\n[zarvis: role=interface]`), want)
  assert.equal(tag(`${rem}\n${rem}\nplain prompt`), null)
  assert.equal(tag(rem), null)
  assert.equal(tag(`${rem}\nplease look at [zarvis: role=interface]`), null)
  assert.equal(tag('see this: [zarvis: role=interface]'), null)
  assert.equal(tag('<system-reminder>unclosed [zarvis: role=interface]'), null)
  assert.equal(tag(`<system-reminder>a</system-reminder> quoted <system-reminder>[zarvis: role=interface]</system-reminder>`), null)
  assert.deepEqual(tag(`${rem}\n[zarvis: role=worker parent=${id(3)}] do it`), { sessionId: id(2), role: 'worker', parent: id(3), at: 1 })
})

test('roleMarker only builds tags for real roles and clean parents', () => {
  assert.equal(roleMarker('manager'), '[zarvis: role=manager]')
  assert.equal(roleMarker('worker', id(2)), `[zarvis: role=worker parent=${id(2)}]`)
  assert.equal(roleMarker('worker', 'a b]'), '[zarvis: role=worker]')
  assert.equal(roleMarker('boss'), '')
  assert.equal(roleMarker(''), '')
})

test('roster lists each manager with its workers and is stable across renders', () => {
  const w = { sessionId: id(3), desktopSessionId: `local_${id(3)}`, name: 'Fix  login', state: 'blocked', project: 'api', branch: 'main' }
  const tree = { interface: [], managers: [{ sessionId: id(2), name: 'Auth', project: 'api', children: [w] }, { sessionId: id(4), name: 'Empty', project: '', children: [] }], orphans: [], unclassified: [] }
  const text = renderRoster(tree)
  assert.match(text, /## Manager: Auth/)
  assert.match(text, /Fix login — blocked — api › main/)
  assert.match(text, new RegExp(`session \\\`${id(3)}\\\``))
  assert.match(text, /workers: none attached/)
  assert.equal(renderRoster(tree), text)
  assert.match(renderRoster({ interface: [], managers: [], orphans: [], unclassified: [] }), /No managers yet/)
})

test('rolePrompt gives every role a pointer line, and others nothing', () => {
  assert.equal(rolePrompt('interface'), '[zarvis: role=interface] Use the zarvis-interface skill (installed by npm run setup) for your role. The roster is ~/.zarvis/roster.md.')
  assert.equal(rolePrompt('manager', '', '/r.md'), '[zarvis: role=manager] Your workers are listed in /r.md. Use the zarvis-manager skill (installed by npm run setup) for your role.')
  assert.equal(rolePrompt('worker', id(2)), `[zarvis: role=worker parent=${id(2)}] Use the zarvis-worker skill (installed by npm run setup) for your role.`)
  assert.equal(rolePrompt('worker'), '[zarvis: role=worker] Use the zarvis-worker skill (installed by npm run setup) for your role.')
  assert.equal(rolePrompt('boss'), '')
  assert.equal(rolePrompt('interface').startsWith(roleMarker('interface')), true, 'the hook-parsed tag leads')
})

test('only a real role or an empty one may start a new session', () => {
  for (const ok of ['interface', 'manager', 'worker', '', undefined]) assert.equal(isNewSessionRole(ok), true, String(ok))
  for (const bad of ['boss', 'Manager', 'p', 7]) assert.equal(isNewSessionRole(bad), false, String(bad))
})

test('an explicit no-role beats a hook tag and spawn inference, and a later hand-set role beats it', async () => {
  const records = [rec(1), rec(2, spawnedBy(1)), rec(3, spawnedBy(1))]
  const hook = { [id(1)]: { role: 'manager' }, [id(2)]: { role: 'interface' } } // as roleRegistry merges them
  const set = async (n, role, parent = '') => {
    const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-')), 'state.json')
    await setRole(id(n), role, parent, file)
    return (await readState(file)).roles
  }
  const cleared = classify({ records, roles: { ...hook, ...(await set(2, NO_ROLE)) } })
  assert.equal(cleared.get(id(2)).role, 'unclassified') // hook interface tag overridden
  const spawned = classify({ records, roles: { ...hook, ...(await set(3, NO_ROLE)) } })
  assert.equal(spawned.get(id(3)).role, 'unclassified') // spawn would have made it a worker
  assert.equal(spawned.get(id(3)).managerId, '')
  const again = classify({ records, roles: { ...hook, ...(await set(2, 'worker', id(1))) } })
  assert.equal(again.get(id(2)).role, 'worker') // hand-set over a hook tag still works
  assert.equal(again.get(id(2)).managerId, id(1))
})

test('setRole stores NO_ROLE with no parent; empty still drops the entry', async () => {
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-')), 'state.json')
  await setRole(id(3), NO_ROLE, id(2), file)
  assert.equal((await readState(file)).roles[id(3)].role, NO_ROLE)
  assert.equal((await readState(file)).roles[id(3)].parent, undefined)
  await setRole(id(3), '', '', file)
  assert.deepEqual((await readState(file)).roles, {})
})

test('roster lists parked workers apart, with reason, date, session id and the first line of the note', () => {
  const live = { sessionId: id(3), name: 'Live', state: 'idle', project: 'api', branch: 'main' }
  const parked = { sessionId: id(5), desktopSessionId: `local_${id(5)}`, name: 'Old  job', state: 'idle', project: 'api', branch: 'fix/x', parked: { parkedAt: Date.UTC(2026, 9, 26, 12), reason: 'merged in PR 7', wake: { type: 'date', value: '2026-11-01' }, handoffNote: '\nBranch fix/x, PR 7.\nVerified by tests.' } }
  const tree = { interface: [], managers: [{ sessionId: id(2), name: 'Auth', project: 'api', children: [live, parked] }, { sessionId: id(4), name: 'Done', project: '', children: [{ ...parked, sessionId: id(6) }] }], orphans: [], unclassified: [] }
  const text = renderRoster(tree)
  const [auth, other] = text.split('## Manager: ').slice(1)
  assert.match(auth, /- workers:\n  - Live — idle/)
  assert.match(auth, /- parked .*:\n  - Old job — parked — merged in PR 7 — 2026-10-26 — wakes 2026-11-01 — api › fix\/x/)
  assert.match(auth, new RegExp(`session \\\`${id(5)}\\\` · app[^\\n]*\\n    note: Branch fix/x, PR 7\\.\\n`))
  assert.ok(!/Verified by tests/.test(auth), 'only the first line of the note')
  assert.match(other, /workers: none live/)
  assert.ok(!/Old job — idle/.test(text), 'a parked worker is not listed as live')
})

test('a fresher cwd (from the hook marker) beats the record\'s', () => {
  const scratch = '/app/scratch-workspaces/ws-1'
  const r = { ...rec(1), cwd: scratch, originCwd: scratch }
  assert.equal(classify({ records: [r] }).get(r.cliSessionId).cwd, scratch)
  assert.equal(classify({ records: [r], cwds: { [r.cliSessionId]: '/r/proj' } }).get(r.cliSessionId).cwd, '/r/proj')
})

test('classify handles non-record sessions (Antigravity) and respects their roles', () => {
  const agySession = { sessionId: id(5), title: 'Antigravity session', runtime: 'antigravity', cwd: '/r/5' }
  const nodes = classify({
    records: [rec(1)],
    roles: { [id(5)]: { role: 'manager' } },
    sessions: [agySession],
  })
  assert.equal(nodes.has(id(5)), true)
  assert.equal(nodes.get(id(5)).role, 'manager')
  assert.equal(nodes.get(id(5)).runtime, 'antigravity')

  const agyWorker = { sessionId: id(6), title: 'Antigravity worker', runtime: 'antigravity', cwd: '/r/6' }
  const nodes2 = classify({
    records: [],
    roles: { [id(5)]: { role: 'manager' }, [id(6)]: { role: 'worker', parent: id(5) } },
    sessions: [agySession, agyWorker],
  })
  assert.equal(nodes2.get(id(6)).role, 'worker')
  assert.equal(nodes2.get(id(6)).managerId, id(5))
  assert.deepEqual(childrenOf(nodes2).get(id(5)).map((n) => n.sessionId), [id(6)])
})

test('aged-out Antigravity swarm worker with pre-enriched agyMeta retains runtime, title, cwd, and manager in classify and roster (#9)', () => {
  const workerId = id(8)
  const mgrId = id(2)
  const title = '@worker-1: optimize database queries for analytics'

  // Worker is not in live sessions (it aged out), but is registered in roles with pre-enriched agyMeta
  const nodes = classify({
    records: [],
    roles: {
      [mgrId]: { role: 'manager' },
      [workerId]: { role: 'worker', parent: mgrId },
    },
    cwds: { [workerId]: '/work/analytics' },
    sessions: [], // empty: worker's live marker aged out
    agyMeta: {
      [workerId]: { isAgy: true, runtime: 'antigravity', title },
    },
  })

  const node = nodes.get(workerId)
  assert.ok(node, 'worker node exists in classified tree')
  assert.equal(node.role, 'worker')
  assert.equal(node.managerId, mgrId)
  assert.equal(node.runtime, 'antigravity', 'runtime resolved from agyMeta')
  assert.equal(node.title, title)
  assert.equal(node.cwd, '/work/analytics')

  // Verify roster rendering with + AGY badge, title, project, and branch
  const workerNode = {
    sessionId: workerId,
    name: node.title,
    state: 'idle',
    runtime: node.runtime,
    project: 'analytics',
    branch: 'develop',
    tasks: {},
  }
  const mgrNode = {
    sessionId: mgrId,
    name: 'Analytics Mgr',
    state: 'idle',
    runtime: 'antigravity',
    project: 'analytics',
    branch: 'main',
    children: [workerNode],
  }
  const tree = { interface: [], managers: [mgrNode], orphans: [], unclassified: [] }
  const roster = renderRoster(tree)
  assert.match(roster, /- @worker-1: optimize database queries for analytics — idle — analytics › develop/)
  assert.equal(workerNode.runtime, 'antigravity')
})

test('classify is pure and does no Antigravity filesystem I/O when agyMeta is omitted', async () => {
  const prevAgyHome = process.env.ANTIGRAVITY_HOME
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-roles-pure-'))
  process.env.ANTIGRAVITY_HOME = tmpDir
  try {
    const workerId = id(8)
    const mgrId = id(2)
    const trDir = path.join(tmpDir, 'brain', workerId, '.system_generated', 'logs')
    await fsp.mkdir(trDir, { recursive: true })
    await fsp.writeFile(path.join(trDir, 'transcript.jsonl'), JSON.stringify({
      step_index: 0,
      type: 'SYSTEM_MESSAGE',
      content: `sender=${mgrId} [swarm] You have just started. Your assignment (recorded on the board as #1 for @worker-1): pure test`,
    }) + '\n')

    const nodes = classify({
      records: [],
      roles: { [mgrId]: { role: 'manager' }, [workerId]: { role: 'worker', parent: mgrId } },
      cwds: { [workerId]: '/work/analytics' },
      sessions: [],
    })
    const node = nodes.get(workerId)
    assert.equal(node.runtime, 'claude')
    assert.equal(node.title, 'Untitled session')
    assert.equal(node.cwd, '/work/analytics')
    assert.equal(node.managerId, mgrId)
  } finally {
    if (prevAgyHome === undefined) delete process.env.ANTIGRAVITY_HOME
    else process.env.ANTIGRAVITY_HOME = prevAgyHome
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ---- Issue #18: auto-promotion to manager on first worker spawn + stale interface cleanup ----

test('classify auto-promotes an unclassified parent to manager when a live explicitly-tagged worker names it or was spawned from it (#18)', () => {
  // 1) Worker explicitly tagged with `parent=<untaggedMgr>`
  const byParent = classify({
    records: [rec(2), rec(3)],
    roles: { [id(3)]: { role: 'worker', parent: id(2) } },
  })
  assert.equal(byParent.get(id(2)).role, 'manager')
  assert.equal(byParent.get(id(2)).source, 'spawn')
  assert.equal(byParent.get(id(2)).suggested, '')
  assert.equal(byParent.get(id(3)).managerId, id(2))
  assert.deepEqual(byParent.get(id(3)).warnings, [])
  assert.deepEqual(childrenOf(byParent).get(id(2)).map((n) => n.sessionId), [id(3)])

  // 2) Worker explicitly tagged `[zarvis: role=worker]` (no parent=), linked via desktop spawnedFrom
  const bySpawn = classify({
    records: [rec(2), rec(3, spawnedBy(2)), rec(4, spawnedBy(2))],
    roles: { [id(3)]: { role: 'worker' } },
  })
  assert.equal(bySpawn.get(id(2)).role, 'manager')
  assert.equal(bySpawn.get(id(3)).managerId, id(2))
  assert.deepEqual(bySpawn.get(id(3)).warnings, [])
  // Sibling untagged child spawned by the now-promoted manager also attaches as a worker
  assert.equal(bySpawn.get(id(4)).role, 'worker')
  assert.equal(bySpawn.get(id(4)).managerId, id(2))

  // 3) Explicitly cleared (`NO_ROLE`) parent is NOT auto-promoted; interface parent is NOT auto-promoted
  const clearedParent = classify({
    records: [rec(1), rec(2), rec(3), rec(4)],
    roles: {
      [id(1)]: { role: 'interface' },
      [id(2)]: { role: NO_ROLE },
      [id(3)]: { role: 'worker', parent: id(2) },
      [id(4)]: { role: 'worker', parent: id(1) },
    },
  })
  assert.equal(clearedParent.get(id(2)).role, 'unclassified')
  assert.match(clearedParent.get(id(3)).warnings[0], /not a manager/)
  assert.equal(clearedParent.get(id(1)).role, 'interface')
  assert.match(clearedParent.get(id(4)).warnings[0], /not a manager/)

  // 4) Archived worker does NOT promote an unclassified parent
  const archivedWorker = classify({
    records: [rec(2), rec(3, { isArchived: true })],
    roles: { [id(3)]: { role: 'worker', parent: id(2) } },
  })
  assert.equal(archivedWorker.get(id(2)).role, 'unclassified')
})

test('spawnsWorker detects Claude worker launches without false positives on edits, commits or subagents (#18)', () => {
  const tag = `[zarvis: role=worker parent=${id(2)}] Fix issue`
  // Agent & Task
  assert.equal(spawnsWorker({ tool_name: 'Agent', tool_input: { prompt: tag } }), true)
  assert.equal(spawnsWorker({ tool_name: 'Task', tool_input: { description: '[zarvis: role=worker]', prompt: 'go' } }), true)
  assert.equal(spawnsWorker({ tool_name: 'Agent', tool_input: { prompt: 'plain subagent' } }), false)
  assert.equal(spawnsWorker({ agent_id: 'sub1', tool_name: 'Agent', tool_input: { prompt: tag } }), false)

  // Desktop MCP start_session
  assert.equal(spawnsWorker({ tool_name: 'start_session', tool_input: { prompt: tag } }), true)
  assert.equal(spawnsWorker({ tool_name: 'mcp__ccd_sessions__start_session', tool_input: { prompt: tag } }), true)
  assert.equal(spawnsWorker({ tool_name: 'start_session', tool_input: { prompt: '[zarvis: role=manager]' } }), false)

  // Bash claude://code/new deep links (URLSearchParams `+` encoding, `%20` encoding, raw) and claude CLI
  const link = newSessionLink('/repo', tag)
  assert.equal(spawnsWorker({ tool_name: 'Bash', tool_input: { command: `open "${link}"` } }), true)
  assert.equal(spawnsWorker({ tool_name: 'Bash', tool_input: { command: 'open "claude://code/new?q=%5Bzarvis%3A%20role%3Dworker%5D"' } }), true)
  assert.equal(spawnsWorker({ tool_name: 'Bash', tool_input: { command: `claude -p "${tag}"` } }), true)
  assert.equal(spawnsWorker({ tool_name: 'Bash', tool_input: { command: `cd /tmp/wt && FOO=1 /usr/local/bin/claude "${tag}"` } }), true)

  // Must NOT false-positive on git commit, grep, or file-editing tools mentioning the tag
  assert.equal(spawnsWorker({ tool_name: 'Bash', tool_input: { command: `git commit -m "handle claude [zarvis: role=worker]"` } }), false)
  assert.equal(spawnsWorker({ tool_name: 'Bash', tool_input: { command: 'grep "[zarvis: role=worker]" hooks/zarvis-hook.mjs' } }), false)
  assert.equal(spawnsWorker({ tool_name: 'Edit', tool_input: { file_path: '/a.js', new_string: tag } }), false)
})

test('Claude hook auto-promotes untagged session to manager on worker spawn (PreToolUse / PostToolUse), never overwrites existing tag, and enables park CLI (#18)', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hook-promote-'))
  const hook = new URL('../hooks/zarvis-hook.mjs', import.meta.url).pathname
  const runHook = (mode, payload) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env: { ...process.env, ZARVIS_HOME: home } })
  const readTag = async (sid) => {
    try {
      return JSON.parse(await fsp.readFile(path.join(home, 'roles', `${sid}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  const untaggedMgr = id(2)
  const workerId = id(3)
  const existingIface = id(1)

  // Session starts untagged
  runHook('start', { session_id: untaggedMgr, prompt: 'Coordinate the release' })
  assert.equal(await readTag(untaggedMgr), null)

  // Subagent event must NOT promote parent
  runHook('resume', { session_id: untaggedMgr, agent_id: 'sub99', tool_name: 'Agent', tool_input: { prompt: `[zarvis: role=worker parent=${untaggedMgr}]` } })
  assert.equal(await readTag(untaggedMgr), null)

  // Main-session PreToolUse (`resume`) spawning a worker promotes untaggedMgr to `manager`
  runHook('resume', {
    session_id: untaggedMgr,
    tool_name: 'Bash',
    tool_input: { command: `open "${newSessionLink('/r/2', `[zarvis: role=worker parent=${untaggedMgr}] implement fix`)}"` },
  })
  const promoted = await readTag(untaggedMgr)
  assert.equal(promoted?.role, 'manager')
  assert.equal(promoted?.parent, '')

  // PostToolUse (`work`) also promotes an untagged session
  const untaggedMgr2 = id(6)
  runHook('start', { session_id: untaggedMgr2, prompt: 'Another coordinator' })
  runHook('work', { session_id: untaggedMgr2, tool_name: 'Agent', tool_input: { prompt: `[zarvis: role=worker parent=${untaggedMgr2}] task` } })
  assert.equal((await readTag(untaggedMgr2))?.role, 'manager')

  // Existing `interface` tag is never overwritten by wx
  runHook('start', { session_id: existingIface, prompt: '[zarvis: role=interface] triage' })
  assert.equal((await readTag(existingIface))?.role, 'interface')
  runHook('resume', { session_id: existingIface, tool_name: 'Agent', tool_input: { prompt: '[zarvis: role=worker] oops' } })
  assert.equal((await readTag(existingIface))?.role, 'interface')

  // Promoted manager can immediately park its worker via runPark
  const stateFile = path.join(home, 'state.json')
  const out = []
  const code = await runPark(['park', workerId, '--by', untaggedMgr, '--reason', 'merged'], {
    deps: {
      records: [rec(2), rec(3)],
      roles: { [untaggedMgr]: promoted, [workerId]: { role: 'worker', parent: untaggedMgr } },
      blocked: [],
      working: [],
    },
    stateFile,
    log: (l) => out.push(l),
    err: () => {},
  })
  assert.equal(code, 0)
  assert.match(out[0], /parked “S3”/)
})

test('renderRoster and buildLookup suppress duplicate untitled zero-activity interface ghosts when a real or newer interface exists (#18)', async () => {
  const real = { sessionId: id(1), desktopSessionId: `local_${id(1)}`, name: 'Zarvis Triage', title: 'Zarvis Triage', state: 'idle', lastActivityAt: 5000 }
  const ghostA = { sessionId: id(7), desktopSessionId: '', name: 'Untitled session', title: 'Untitled session', state: 'unknown', lastActivityAt: 0 }
  const ghostB = { sessionId: id(8), desktopSessionId: '', name: 'Untitled session', title: 'Untitled session', state: 'no signal', lastActivityAt: 0 }

  assert.equal(isGhostInterface(ghostA), true)
  assert.equal(isGhostInterface(ghostB), true)
  assert.equal(isGhostInterface(real), false)
  assert.deepEqual(visibleInterfaces([ghostA, real, ghostB]).map((i) => i.sessionId), [id(1)])

  const roster = renderRoster({ interface: [ghostA, real, ghostB], managers: [], orphans: [], unclassified: [] })
  assert.match(roster, /## Interface: Zarvis Triage/)
  assert.doesNotMatch(roster, /## Interface: Untitled session/)

  // Two legitimate titled/desktop interfaces are BOTH kept
  const real2 = { sessionId: id(9), desktopSessionId: `local_${id(9)}`, name: 'Second Interface', title: 'Second Interface', state: 'unknown', lastActivityAt: 6000 }
  const bothRoster = renderRoster({ interface: [real, real2], managers: [], orphans: [], unclassified: [] })
  assert.match(bothRoster, /## Interface: Zarvis Triage/)
  assert.match(bothRoster, /## Interface: Second Interface/)

  // A single untitled interface is kept when it is the only interface
  const singleRoster = renderRoster({ interface: [ghostA], managers: [], orphans: [], unclassified: [] })
  assert.match(singleRoster, /## Interface: Untitled session/)

  // buildLookup (`npm run roster -- list`) hides stale ghosts by default, while `--all` still includes them
  const lookupDeps = {
    findTranscript: async () => null,
    transcriptMeta: async () => ({ cwd: '', gitBranch: '', title: '', spawnedFrom: '' }),
    gitBranchOf: async () => '',
    findAntigravityTitle: async () => '',
  }
  const world = {
    records: [rec(1, { title: 'Zarvis Triage', lastActivityAt: 10_000 })],
    state: { overlays: {}, roles: {}, parked: {}, done: {} },
    roles: { [id(1)]: { role: 'interface' }, [id(7)]: { role: 'interface' } },
    now: 20_000,
    deps: lookupDeps,
    branchOf: async () => '',
  }
  const prevAgy = process.env.ANTIGRAVITY_HOME
  const tmpAgy = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-lookup-agy-'))
  process.env.ANTIGRAVITY_HOME = tmpAgy
  try {
    const defaultList = await buildLookup({ ...world, all: false })
    assert.deepEqual(defaultList.filter((e) => e.role === 'interface').map((e) => e.sessionId), [id(1)])
    const allList = await buildLookup({ ...world, all: true })
    assert.equal(allList.filter((e) => e.role === 'interface').length, 2)
  } finally {
    if (prevAgy === undefined) delete process.env.ANTIGRAVITY_HOME
    else process.env.ANTIGRAVITY_HOME = prevAgy
    await fsp.rm(tmpAgy, { recursive: true, force: true }).catch(() => {})
  }
})
