import test from 'node:test'
import assert from 'node:assert/strict'
import { initiativeOf, buildQueue, deepLinkFor, newSessionLink, splitWorktree, pickRecord } from '../lib/queue.mjs'

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
