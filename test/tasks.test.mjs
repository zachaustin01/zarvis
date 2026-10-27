import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchOf, stoppedId, fromStopEntry, reconcile, liveTasks, finishedText, trackTasks, readAllTasks, tasksFile, MAX_TASK_AGE_MS } from '../lib/tasks.mjs'
import { buildQueue, taskSummary } from '../lib/queue.mjs'
import { renderRoster } from '../lib/roster.mjs'

const SID = 'f6cce3a1-cd4c-4de5-bb8d-e7375ea36a85'
const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'hooks', 'zarvis-hook.mjs')
const NOW = 1_800_000_000_000
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-tasks-'))

// Shapes copied from real transcripts (toolUseResult) and the hooks reference (Stop `background_tasks`).
const bashLaunch = (extra = {}) => ({
  session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01AstzcTLP9UykHefnC2os5L',
  tool_input: { command: 'nohup just dev > /tmp/dev.log 2>&1 & disown', description: 'Start dagster dev server', run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'byhjbmkya' },
  ...extra,
})
const monitor = { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Monitor', tool_use_id: 'toolu_011nZVAyY8BhZNeCFVWeaNAf', tool_input: { command: 'until grep -q DONE out; do sleep 5; done', description: 'wait for the load', timeout_ms: 1800000, persistent: 'false' }, tool_response: { taskId: 'bsdfympsi', timeoutMs: 1800000, persistent: false } }
const agent = { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_agent1', tool_input: { description: 'Find SHAP view', prompt: 'investigate…', run_in_background: true }, tool_response: { isAsync: true, status: 'async_launched', agentId: 'a867469f24ed288f6', description: 'Find SHAP view' } }
const stop = (tasks) => ({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok', background_tasks: tasks, session_crons: [] })
const shellEntry = { id: 'byhjbmkya', type: 'shell', status: 'running', description: 'Start dagster dev server', command: 'nohup just dev' }

test('launchOf recognises the three launch shapes and uses the real task id', () => {
  assert.deepEqual(launchOf(bashLaunch(), NOW), { id: 'byhjbmkya', kind: 'shell', label: 'Start dagster dev server', startedAt: NOW, until: 0, guess: false })
  const m = launchOf(monitor, NOW)
  assert.equal(m.id, 'bsdfympsi'); assert.equal(m.kind, 'monitor'); assert.equal(m.until, NOW + 1800000)
  const a = launchOf(agent, NOW)
  assert.equal(a.id, 'a867469f24ed288f6'); assert.equal(a.kind, 'subagent')
})

test('launchOf ignores foreground calls and falls back to tool_use_id as a guess', () => {
  assert.equal(launchOf({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }), null)
  assert.equal(launchOf({ tool_name: 'Read', tool_input: { file_path: '/x' } }), null)
  assert.equal(launchOf({ tool_name: 'Agent', tool_input: { description: 'x' }, tool_response: { content: 'done' } }), null)
  const g = launchOf(bashLaunch({ tool_response: 'Command running in background with ID: x' }), NOW)
  assert.equal(g.id, 'toolu_01AstzcTLP9UykHefnC2os5L'); assert.equal(g.guess, true)
  assert.equal(launchOf(null), null)
})

test('stoppedId reads TaskStop and KillShell', () => {
  assert.equal(stoppedId({ tool_name: 'TaskStop', tool_input: { task_id: 'bvj17q8tu' } }), 'bvj17q8tu')
  assert.equal(stoppedId({ tool_name: 'KillShell', tool_input: { shell_id: 'sh1' } }), 'sh1')
  assert.equal(stoppedId({ tool_name: 'Bash', tool_input: { task_id: 'x' } }), '')
})

test('fromStopEntry skips finished entries and builds a label per type', () => {
  assert.equal(fromStopEntry({ id: 'a', type: 'shell', status: 'completed' }, NOW), null)
  assert.equal(fromStopEntry(null, NOW), null)
  assert.equal(fromStopEntry({ type: 'shell' }, NOW), null) // no id
  assert.equal(fromStopEntry({ id: 'm', type: 'monitor', status: 'running', tool: 'tail', server: 's' }, NOW).label, 'tail')
  assert.equal(fromStopEntry({ id: 's', type: 'subagent', status: 'running', agent_type: 'Explore' }, NOW).label, 'Explore')
  assert.equal(fromStopEntry({ id: 'x', type: 'MCP task', status: 'running', description: 'a\nb\u0007c' }, NOW).label, 'a b c')
  assert.equal(fromStopEntry({ id: 'x', type: 'MCP task', status: 'running' }, NOW).kind, 'mcp-task')
})

test('reconcile: Stop list wins; a guessed launch matches by kind+label; vanished tasks are finished', () => {
  const prev = [
    { id: 'toolu_1', kind: 'shell', label: 'dev server', startedAt: 5, until: 0, guess: true },
    { id: 'real2', kind: 'shell', label: 'tests', startedAt: 6, until: 0, guess: false },
  ]
  const next = [{ id: 'abc', kind: 'shell', label: 'dev server', startedAt: NOW, until: 0, guess: false }]
  const r = reconcile(prev, next)
  assert.deepEqual(r.tasks.map((t) => [t.id, t.startedAt]), [['abc', 5]])
  assert.deepEqual(r.finished.map((t) => t.id), ['real2'])
})

test('liveTasks expires by `until` or by age', () => {
  const t = [{ id: 'a', startedAt: NOW - 1000, until: NOW - 1 }, { id: 'b', startedAt: NOW - MAX_TASK_AGE_MS - 1, until: 0 }, { id: 'c', startedAt: NOW - 1000, until: 0 }]
  assert.deepEqual(liveTasks(t, NOW).map((x) => x.id), ['c'])
})

test('finishedText', () => {
  assert.equal(finishedText([]), '')
  assert.equal(finishedText([{ kind: 'shell', label: 'npm test' }]), 'finished a background command: npm test')
  assert.equal(finishedText([{ kind: 'subagent', label: 'Explore' }]), 'finished a background subagent: Explore')
  assert.match(finishedText([{ label: 'a' }, { label: 'b' }, { label: 'c' }]), /^finished 3 background tasks: a, b, …$/)
})

test('lifecycle: launch, Stop keeps it, TaskStop removes, SessionEnd clears, subagent and bad input ignored', async () => {
  const home = await tmp()
  const file = tasksFile(home, SID)
  await trackTasks('work', bashLaunch(), home, NOW)
  assert.deepEqual((await readAllTasks(home, NOW))[SID].map((t) => t.id), ['byhjbmkya'])
  await trackTasks('work', bashLaunch({ agent_id: 'sub1', tool_response: { backgroundTaskId: 'sub-task' } }), home, NOW) // a subagent's launch
  assert.equal((await readAllTasks(home, NOW))[SID].length, 1)
  assert.deepEqual(await trackTasks('idle', stop([shellEntry]), home, NOW + 1000), [])
  assert.equal((await readAllTasks(home, NOW + 1000))[SID][0].startedAt, NOW, 'startedAt survives the Stop snapshot')
  assert.deepEqual(await trackTasks('idle', { ...stop([]), agent_id: 'sub1' }, home, NOW + 2000), [], 'a subagent Stop does not clear')
  assert.equal((await readAllTasks(home, NOW + 2000))[SID].length, 1)
  const fin = await trackTasks('work', { session_id: SID, tool_name: 'TaskStop', tool_input: { task_id: 'byhjbmkya' } }, home, NOW + 3000)
  assert.deepEqual(fin.map((t) => t.id), ['byhjbmkya'])
  await assert.rejects(fsp.stat(file)) // empty list removes the file
  await trackTasks('work', monitor, home, NOW)
  await trackTasks('done', { session_id: SID }, home, NOW)
  assert.deepEqual(await readAllTasks(home, NOW), {})
})

test('Stop with an empty list reports what finished; a Stop without the field changes nothing; SessionStart clears', async () => {
  const home = await tmp()
  await trackTasks('work', agent, home, NOW)
  assert.deepEqual(await trackTasks('idle', { session_id: SID, hook_event_name: 'Stop' }, home, NOW + 1), [])
  assert.equal((await readAllTasks(home, NOW + 1))[SID].length, 1)
  const fin = await trackTasks('idle', stop([]), home, NOW + 2)
  assert.deepEqual(fin.map((t) => t.kind), ['subagent'])
  await trackTasks('work', monitor, home, NOW)
  await trackTasks('idle', { session_id: SID, hook_event_name: 'SessionStart' }, home, NOW + 3)
  assert.deepEqual(await readAllTasks(home, NOW + 3), {})
})

test('a task whose completion was missed expires; junk files are skipped', async () => {
  const home = await tmp()
  await trackTasks('work', bashLaunch(), home, NOW)
  assert.equal(Object.keys(await readAllTasks(home, NOW + MAX_TASK_AGE_MS - 1)).length, 1)
  assert.deepEqual(await readAllTasks(home, NOW + MAX_TASK_AGE_MS + 1), {})
  await fsp.rm(tasksFile(home, SID))
  await fsp.writeFile(tasksFile(home, 'bbbbbbbb-0000-4000-8000-000000000002'), '{nope')
  await fsp.writeFile(tasksFile(home, 'cccccccc-0000-4000-8000-000000000003'), JSON.stringify({ tasks: 'x' }))
  assert.deepEqual(await readAllTasks(home, NOW), {})
})

test('the hook script end to end: launch, Stop with and without the task, ticker event, SessionEnd', async () => {
  const home = await tmp()
  const run = (mode, payload) => spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(payload), env: { ...process.env, ZARVIS_HOME: home }, encoding: 'utf8', timeout: 8000 })
  const r = run('work', bashLaunch())
  assert.equal(r.status, 0); assert.equal(r.stdout + r.stderr, '')
  assert.equal((await readAllTasks(home))[SID][0].id, 'byhjbmkya')
  run('idle', stop([shellEntry]))
  assert.equal((await readAllTasks(home))[SID].length, 1)
  assert.equal((await fsp.readFile(path.join(home, 'working', `${SID}.json`), 'utf8')).includes('"idle"'), true)
  run('idle', stop([]))
  assert.deepEqual(await readAllTasks(home), {})
  const ev = (await fsp.readFile(path.join(home, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'done'); assert.equal(ev[0].text, 'finished a background command: Start dagster dev server'); assert.equal(ev[0].sessionId, SID)
  run('work', monitor)
  run('done', { session_id: SID, hook_event_name: 'SessionEnd' })
  assert.deepEqual(await readAllTasks(home), {})
  // malformed input never throws or prints
  const bad = spawnSync(process.execPath, [HOOK, 'idle'], { input: '{"session_id":"' + SID + '","background_tasks":"nope"}', env: { ...process.env, ZARVIS_HOME: home }, encoding: 'utf8' })
  assert.equal(bad.status, 0); assert.equal(bad.stdout + bad.stderr, '')
})

test('no ticker event when auto events are off', async () => {
  const home = await tmp()
  const env = { ...process.env, ZARVIS_HOME: home, ZARVIS_AUTO_EVENTS: '0' }
  const run = (mode, payload) => spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 8000 })
  run('work', bashLaunch()); run('idle', stop([]))
  await assert.rejects(fsp.stat(path.join(home, 'events.jsonl')))
})

test('queue rows and the roster carry the task count', async () => {
  const deps = { findTranscript: async () => null, transcriptMeta: async () => ({}), gitBranchOf: async () => '' }
  const records = [{ sessionId: 'local_a', cliSessionId: SID, title: 'T', cwd: '/r/p', originCwd: '/r/p', branch: 'main' }]
  const working = [{ sessionId: SID, state: 'idle', at: NOW - 5, seen: NOW - 5, cwd: '/r/p' }]
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, kind: 'shell', label: `cmd ${i}`, startedAt: NOW - 10, until: 0 }))
  const q = await buildQueue({ markers: [], working, tasks: { [SID]: mk(5) }, records, now: NOW, deps })
  assert.equal(q[0].state, 'idle'); assert.equal(q[0].tasks.count, 5); assert.equal(q[0].tasks.items.length, 3)
  assert.deepEqual((await buildQueue({ markers: [], working, records, now: NOW, deps }))[0].tasks, { count: 0, items: [] })
  assert.equal(taskSummary([{ id: 'x', kind: 'shell', label: '', startedAt: 1, until: 0 }], NOW + MAX_TASK_AGE_MS).count, 0)
  const tree = { interface: [], archived: [], managers: [{ name: 'M', sessionId: 'm1', project: 'p', children: [{ name: 'W', state: 'idle', tasks: { count: 2 }, sessionId: SID, project: 'p', branch: 'b' }] }] }
  assert.match(renderRoster(tree, [], NOW), /W — idle \(2 background tasks running\)/)
})
