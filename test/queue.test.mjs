import test from 'node:test'
import assert from 'node:assert/strict'
import { initiativeOf, buildQueue, deepLinkFor, newSessionLink, splitWorktree, pickRecord, projectPathOf, isScratch } from '../lib/queue.mjs'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'
const D = 'dddddddd-0000-4000-8000-000000000004'
const E = 'eeeeeeee-0000-4000-8000-000000000005'
const desk = (n) => `local_${n.repeat(8)}-0000-4000-8000-000000000000`
const NOW = 1_000_000_000
const deps = { findTranscript: async () => null, transcriptMeta: async () => ({}), gitBranchOf: async () => 'from-git' }
const mk = (id, ago, extra = {}) => ({ sessionId: id, at: NOW - ago, cwd: '', message: 'needs permission', tool: 'Bash', command: 'ls', transcriptPath: '', ...extra })

const records = [
  { sessionId: desk('a'), cliSessionId: A, title: 'Alpha task', cwd: '/r/proj', originCwd: '/r/proj', branch: 'main' },
  { sessionId: desk('b'), cliSessionId: B, title: 'Beta', cwd: '/r/proj/.claude/worktrees/wt1', originCwd: '/r/proj', worktreeName: 'wt1', branch: 'claude/ABC-123-fix' },
  { sessionId: desk('c'), cliSessionId: C, title: 'Archived', cwd: '/r/x', isArchived: 'True' },
]

test('orders longest wait first, with worktree, ticket and link resolved', async () => {
  const q = await buildQueue({ markers: [mk(A, 1000), mk(B, 90000)], records, now: NOW, deps })
  assert.deepEqual(q.map((r) => r.sessionId), [B, A])
  assert.equal(q[0].project, 'proj')
  assert.equal(q[0].worktree, 'wt1')
  assert.equal(q[0].initiative, 'ABC-123')
  assert.equal(q[0].link, `claude://claude.ai/epitaxy/${desk('b')}`)
  assert.equal(q[0].waitMs, 90000)
})

test('drops stale, archived, deleted and nonexistent sessions', async () => {
  const markers = [mk(A, 13 * 3600 * 1000), mk(C, 10), mk(B, 10), mk(D, 10)]
  const q = await buildQueue({ markers, records, deleted: new Set([B]), now: NOW, deps })
  assert.deepEqual(q, [])
})

test('overlay name wins and the app title is kept beside it', async () => {
  const [r] = await buildQueue({ markers: [mk(A, 5)], records, overlays: { [A]: { name: 'Mine' } }, now: NOW, deps })
  assert.equal(r.name, 'Mine')
  assert.equal(r.title, 'Alpha task')
})

test('leaf-only: sessions without a marker never appear, parents included', async () => {
  const withParent = [...records, { sessionId: desk('d'), cliSessionId: D, title: 'Parent', cwd: '/r/p' }]
  const q = await buildQueue({ markers: [mk(A, 5)], records: withParent, now: NOW, deps })
  assert.deepEqual(q.map((r) => r.sessionId), [A])
})

test('terminal session (transcript only) is listed with no link', async () => {
  const d2 = { ...deps, findTranscript: async () => ({ file: '/t.jsonl' }), transcriptMeta: async () => ({ cwd: '/r/term', gitBranch: 'dev', title: 'term title' }) }
  const [r] = await buildQueue({ markers: [mk(D, 5)], records: [], now: NOW, deps: d2 })
  assert.equal(r.link, '')
  assert.equal(r.project, 'term')
  assert.equal(r.branch, 'dev')
})

test('helpers', () => {
  assert.equal(deepLinkFor('nope'), '')
  assert.deepEqual(splitWorktree('/r/p/.claude/worktrees/x'), { root: '/r/p', worktree: 'x' })
  assert.equal(pickRecord([{ cliSessionId: A, title: '' }, { cliSessionId: A, title: 't' }], A).title, 't')
})

test('newSessionLink opens a new desktop session, in a folder when given one', () => {
  assert.equal(newSessionLink(''), 'claude://code/new')
  assert.equal(newSessionLink('/Users/a b/repo'), 'claude://code/new?folder=%2FUsers%2Fa+b%2Frepo')
})

const wk = (id, ago, seenAgo = 0, state = 'working') => ({ sessionId: id, state, at: NOW - ago, seen: NOW - seenAgo })

test('working sessions follow blocked ones, never twice, and go stale sooner', async () => {
  const q = await buildQueue({ markers: [mk(A, 1000)], working: [wk(A, 9000), wk(B, 50000), wk(D, 99999, 31 * 60 * 1000)], records, now: NOW, deps })
  assert.deepEqual(q.map((r) => [r.sessionId, r.state]), [[A, 'blocked'], [B, 'working']])
})

test('idle sessions come last, newest first, and age out on the long limit', async () => {
  const q = await buildQueue({ markers: [], working: [wk(A, 5000, 0, 'idle'), wk(B, 1000, 0, 'idle'), wk(E, 50, 0), wk(D, 13 * 3600 * 1000, 0, 'idle')], records: [...records, { sessionId: desk('d'), cliSessionId: D, title: 'D', cwd: '/r/d' }, { sessionId: desk('e'), cliSessionId: E, title: 'E', cwd: '/r/e' }], now: NOW, deps })
  assert.deepEqual(q.map((r) => [r.sessionId, r.state]), [[E, 'working'], [B, 'idle'], [A, 'idle']])
})

test('newSessionLink can prefill the prompt', () => {
  assert.equal(newSessionLink('', '[zarvis: role=manager]'), 'claude://code/new?q=%5Bzarvis%3A+role%3Dmanager%5D')
  assert.equal(newSessionLink('/r', 'hi'), 'claude://code/new?folder=%2Fr&q=hi')
})

test('initiativeOf finds a ticket id in the branch, else the worktree name', () => {
  assert.equal(initiativeOf('feat/ABC-123-rate-limit', ''), 'ABC-123')
  assert.equal(initiativeOf('main', 'ABC-9-spike'), 'ABC-9')
  assert.equal(initiativeOf('main', ''), '')
})

test('a question marker is a blocked row of kind question, counted with the rest of Needs you', async () => {
  const q = await buildQueue({ markers: [mk(A, 1000, { kind: 'question', tool: '', command: 'Ship it?', message: 'Waiting for your answer' }), mk(B, 500)], records, now: NOW, deps })
  assert.deepEqual(q.map((r) => [r.sessionId, r.state, r.kind]), [[A, 'blocked', 'question'], [B, 'blocked', 'permission']])
  assert.equal(q[0].prompt, 'Waiting for your answer')
  assert.equal(q[0].command, 'Ship it?')
  // a working/idle marker for a session that asked is hidden behind its blocked one
  const w = [{ sessionId: A, state: 'idle', at: NOW - 900, seen: NOW - 900 }]
  const q2 = await buildQueue({ markers: [mk(A, 1000, { kind: 'question' })], working: w, records, now: NOW, deps })
  assert.deepEqual(q2.map((r) => r.state), ['blocked'])
})

const SCRATCH = '/Users/u/Library/Application Support/Claude/scratch-workspaces/ws-1'

test('a session that left its scratch workspace is listed under the project its marker reports', async () => {
  const recs = [{ sessionId: desk('d'), cliSessionId: D, title: 'Moved', cwd: SCRATCH, originCwd: SCRATCH }]
  const [r] = await buildQueue({ markers: [mk(D, 5, { cwd: '/r/real-proj' })], records: recs, now: NOW, deps })
  assert.equal(r.project, 'real-proj')
  assert.equal(r.folder, '/r/real-proj')
  assert.equal(r.cwd, '/r/real-proj')
  assert.equal(r.branch, 'from-git') // read from the new checkout, not the scratch one
})

test('moved into a worktree: the project is the repo root, the worktree is named', async () => {
  const recs = [{ sessionId: desk('d'), cliSessionId: D, title: 'Moved', cwd: SCRATCH, originCwd: SCRATCH, branch: 'claude/x' }]
  const [r] = await buildQueue({ markers: [mk(D, 5, { cwd: '/r/real-proj/.claude/worktrees/wt9' })], records: recs, now: NOW, deps })
  assert.equal(r.project, 'real-proj')
  assert.equal(r.worktree, 'wt9')
})

test('without a marker cwd the record is the fallback, scratch or not', async () => {
  const recs = [{ sessionId: desk('d'), cliSessionId: D, title: 'Still there', cwd: SCRATCH, originCwd: SCRATCH }]
  const [r] = await buildQueue({ markers: [mk(D, 5)], records: recs, now: NOW, deps })
  assert.equal(r.project, 'ws-1')
  const [n] = await buildQueue({ markers: [mk(A, 5)], records, now: NOW, deps })
  assert.equal(n.project, 'proj')
})

test('real worktree sessions keep the repo as their project even when the marker is the worktree', async () => {
  const [r] = await buildQueue({ markers: [mk(B, 5, { cwd: '/r/proj/.claude/worktrees/wt1' })], records, now: NOW, deps })
  assert.equal(r.project, 'proj')
  assert.equal(r.folder, '/r/proj')
})

test('projectPathOf matches the scratch-workspaces path segment, not a substring', () => {
  assert.equal(projectPathOf('/r/new', SCRATCH), '/r/new')
  assert.equal(projectPathOf('/r/new', '/r/my-scratch-workspaces-notes'), '/r/my-scratch-workspaces-notes')
  assert.equal(isScratch('C:\\Users\\u\\AppData\\Claude\\scratch-workspaces\\ws'), true)
  assert.equal(isScratch('/r/scratch-workspaces-x/y'), false)
})

import { pinnedRows, applyRoles } from '../lib/queue.mjs'
import { classify } from '../lib/roles.mjs'
import { annotateRows, visibleRows } from '../lib/lifecycle.mjs'

test('pinnedRows keeps a signal-less interface session in the queue as "no signal", and nothing else', () => {
  const rec = (n, extra = {}) => ({ sessionId: `local_${String(n).repeat(8)}-0000-4000-8000-000000000000`, cliSessionId: `${String(n).repeat(8)}-0000-4000-8000-000000000000`, title: `S${n}`, cwd: `/code/proj${n}`, createdAt: 1000, lastActivityAt: 5000, ...extra })
  const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
  const records = [rec(1, { originCwd: '/code/brain' }), rec(2), rec(3, { isArchived: true }), rec(4), rec(5, { branch: 'feat/ABC-9-x' })]
  const roles = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [id(n), { role: 'interface' }]))
  roles[id(4)] = { role: 'worker' }
  const nodes = classify({ records, roles })
  const live = [{ sessionId: id(2), state: 'working', since: 0 }] // 2 has a real row
  const got = pinnedRows(nodes, records, live, { now: 9000 })
  assert.deepEqual(got.map((r) => r.sessionId).sort(), [id(1), id(5)]) // 2 has a row, 3 is archived, 4 is a worker
  const one = got.find((r) => r.sessionId === id(1))
  assert.equal(one.state, 'unknown') // never a guessed idle
  assert.equal(one.role, 'interface')
  assert.equal(one.project, 'brain') // project from the record's origin
  assert.equal(one.since, 5000)
  assert.equal(one.waitMs, 4000)
  assert.match(one.link, /^claude:\/\/claude\.ai\/epitaxy\/local_/)
  assert.match(one.prompt, /No signal/)
  assert.equal(got.find((r) => r.sessionId === id(5)).initiative, 'ABC-9')
})

test('a not-running interface follows the lifecycle rules: parked and done leave, it is never needs-you, a live row replaces it', () => {
  const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
  const records = [1, 2, 3].map((n) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `S${n}`, cwd: `/c/${n}`, createdAt: 1 }))
  const nodes = classify({ records, roles: { [id(1)]: { role: 'interface' }, [id(2)]: { role: 'interface' }, [id(3)]: { role: 'interface' } } })
  const state = { parked: { [id(2)]: { reason: 'x', parkedAt: 1, wake: null, handoffNote: '' } }, done: { [id(3)]: true }, overlays: {} }
  const rows = annotateRows(pinnedRows(nodes, records, []), state)
  assert.deepEqual(visibleRows(rows).map((r) => r.sessionId), [id(1)])
  assert.ok(rows.every((r) => r.state !== 'blocked'))
  // once the process is back there is a real row and no synthetic one
  assert.deepEqual(pinnedRows(nodes, records, [{ sessionId: id(1), state: 'idle' }]).map((r) => r.sessionId), [id(2), id(3)])
})

import { PINNED_ROLES } from '../lib/roles.mjs'

test('pinned roles are interface and manager: a signal-less manager gets a not-running row, a worker does not, a live manager rolls up as before', () => {
  const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
  assert.deepEqual(PINNED_ROLES, ['interface', 'manager'])
  const records = [1, 2, 3, 4].map((n) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `S${n}`, cwd: `/c/proj${n}`, createdAt: 1, lastActivityAt: 2 }))
  const roles = { [id(1)]: { role: 'manager' }, [id(2)]: { role: 'worker', parent: id(1) }, [id(3)]: { role: 'manager' }, [id(4)]: { role: 'interface' } }
  const nodes = classify({ records, roles })
  // 3 is a live manager (has a row); 1 has no signal but its worker 2 is blocked
  const live = [{ sessionId: id(3), state: 'idle', since: 5 }, { sessionId: id(2), state: 'blocked', since: 1, name: 'W' }]
  const got = pinnedRows(nodes, records, live)
  assert.deepEqual(got.map((r) => [r.sessionId, r.role, r.state]).sort(), [[id(1), 'manager', 'unknown'], [id(4), 'interface', 'unknown']])
  assert.ok(!got.some((r) => r.sessionId === id(2))) // workers are not pinned
  // a manager that does have a row still becomes waiting_on_child under a blocked worker
  const rolled = applyRoles([{ sessionId: id(1), state: 'idle', since: 1 }, { sessionId: id(2), state: 'blocked', since: 1, name: 'W' }], nodes)
  assert.equal(rolled.find((r) => r.sessionId === id(1)).state, 'waiting_on_child')
})
