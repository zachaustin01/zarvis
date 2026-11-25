import test from 'node:test'
import assert from 'node:assert/strict'
import { fuzzy, parseMode, scoreSession, search, buildCommands, COMMANDS, keepHighlight, stepHighlight } from '../public/palette.js'

const S = (id, name, extra = {}) => ({ sessionId: id, name, project: 'zarvis', role: 'worker', state: 'idle', branch: '', ...extra })

test('fuzzy: subsequence only, substring and word starts beat scattered matches', () => {
  assert.equal(fuzzy('xyz', 'park selected'), null)
  assert.deepEqual(fuzzy('prk', 'park').idx, [0, 2, 3])
  assert.ok(fuzzy('park', 'park selected').score > fuzzy('park', 'unpark selected').score)
  assert.ok(fuzzy('park', 'unpark').score > fuzzy('prk', 'unpark').score)
  assert.equal(fuzzy('', 'anything').score, 0)
})

test('parseMode: > commands, @ sessions, else both', () => {
  assert.deepEqual(parseMode('>park'), { mode: 'commands', text: 'park' })
  assert.deepEqual(parseMode('@zar'), { mode: 'sessions', text: 'zar' })
  assert.deepEqual(parseMode('zar'), { mode: 'all', text: 'zar' })
  assert.deepEqual(parseMode('#nfl'), { mode: 'projects', text: 'nfl' })
})

test('scoreSession: every token must hit name, project, branch, role or state', () => {
  const r = S('a', 'login fix', { project: 'webapp', branch: 'feat/auth', state: 'blocked', role: 'manager' })
  assert.ok(scoreSession('login', r))
  assert.ok(scoreSession('webapp auth', r))
  assert.ok(scoreSession('manager', r))
  assert.ok(scoreSession('needs', r, 'needs you'))
  assert.equal(scoreSession('login zzz', r), null)
})

test('scoreSession: supports field filtering and penalizes branch-only matches', () => {
  const branchOnly = S('b1', 'Worker 1', { branch: 'feat/ticket-1234' })
  const contentMatch = S('c1', 'Worker 2', { prompt: 'fixing ticket-1234 in login', branch: 'main' })

  // Field filtering: searching only prompt/title ignores branch
  assert.equal(scoreSession('ticket-1234', branchOnly, 'idle', { fields: ['prompt', 'title'] }), null)
  assert.ok(scoreSession('ticket-1234', contentMatch, 'idle', { fields: ['prompt', 'title'] }))

  // Branch-only penalty: content match scores substantially higher than branch-only match
  const sBranch = scoreSession('ticket-1234', branchOnly, 'idle', { penalizeBranch: true })
  const sContent = scoreSession('ticket-1234', contentMatch, 'idle', { penalizeBranch: true })
  assert.equal(sBranch.branchOnly, true)
  assert.equal(sContent.branchOnly, false)
  assert.ok(sContent.score > sBranch.score * 3, 'content match beats branch-only match')
})

test('search: ranks by score, modes filter, empty query lists sessions then commands', () => {
  const sessions = [S('a', 'park the build'), S('b', 'docs')]
  const cmds = buildCommands(['zarvis', 'webapp'])
  const all = search('', sessions, cmds, { limit: 100 })
  assert.deepEqual(all.slice(0, 2).map((e) => e.key), ['s:a', 's:b'])
  assert.equal(all.length, 2 + cmds.length)
  assert.equal(search('>', sessions, cmds).every((e) => e.type === 'command'), true)
  assert.equal(search('@', sessions, cmds).every((e) => e.type === 'session'), true)
  const q = search('>park', sessions, cmds)
  assert.ok(q.some((e) => e.key === 'c:park'))
  assert.equal(search('@docs', sessions, cmds)[0].key, 's:b')
})

test('registry: unique ids, every key action has an entry, project commands generated', () => {
  const ids = COMMANDS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length)
  const keys = new Set(COMMANDS.flatMap((c) => c.key.split(' ')))
  for (const k of ['q', 't', 'p', 'Tab', '/', 'g', 'G', 'm', 'w', 'h', 'v', '0', 'Enter', 'i', 'r', 'P', 'u', 'd', 'z', 'a', 'n', 'c', 'C', 'b', 'e', 'E', '?']) assert.ok(keys.has(k), `command for ${k}`)
  const cs = buildCommands(['alpha'])
  assert.ok(cs.some((c) => c.id === 'project:alpha' && c.label === 'Project: alpha'))
  assert.equal(buildCommands([]).some((c) => c.id === 'project-all'), false)
})

test('highlight stays on the same entry across live updates; clamps when it vanishes', () => {
  const e = (...k) => k.map((key) => ({ key }))
  assert.deepEqual(keepHighlight(e('s:a', 's:b', 's:c'), 's:b', 1), { key: 's:b', idx: 1 })
  assert.deepEqual(keepHighlight(e('s:new', 's:a', 's:b', 's:c'), 's:b', 1), { key: 's:b', idx: 2 }) // list shifted under it
  assert.deepEqual(keepHighlight(e('s:a'), 's:gone', 4), { key: 's:a', idx: 0 })
  assert.deepEqual(keepHighlight([], 'x', 2), { key: '', idx: 0 })
  assert.equal(stepHighlight(e('a', 'b'), 1, 1), 1)
  assert.equal(stepHighlight(e('a', 'b'), 0, -1), 0)
})

test('scoreSession: a parked session is found by its park reason, handoff note and who parked it', () => {
  const r = { sessionId: 'a', name: 'checkout', project: 'shop', role: 'worker', state: 'idle', parked: { reason: 'waiting on payments review', handoffNote: 'resume at the webhook retry step', parkedByName: 'shop manager' } }
  assert.ok(scoreSession('payments', r))
  assert.ok(scoreSession('webhook retry', r))
  assert.ok(scoreSession('shop manager', r))
  assert.equal(scoreSession('payments', { ...r, parked: undefined }), null)
})

test('scoreSession: a session is found by the label or host of a link it posted', () => {
  const r = S('a', 'etl worker', { links: [{ url: 'https://dagster.example.com/runs/1', label: 'Dagster run' }, { url: 'javascript:1', label: '' }, null] })
  assert.ok(scoreSession('dagster', r))
  assert.ok(scoreSession('example.com', r))
  assert.equal(scoreSession('grafana', r), null)
  assert.ok(scoreSession('etl', S('b', 'etl worker', { links: 'nope' }))) // junk never throws
  assert.equal(scoreSession('dagster', S('c', 'plain')), null)
})

test('search # (the g picker): All first then projects A to Z; a query narrows by project name only', () => {
  const cmds = buildCommands(['alpha', 'nfl-data', 'zarvis'])
  const rows = [{ sessionId: 's1', name: 'zarvis work', project: 'zarvis', state: 'idle' }]
  assert.deepEqual(search('#', rows, cmds).map((e) => e.label), ['All projects', 'alpha', 'nfl-data', 'zarvis'])
  assert.deepEqual(search('#zar', rows, cmds).map((e) => e.key), ['c:project:zarvis']) // no sessions, no other commands
  assert.deepEqual(search('#all', rows, cmds)[0].key, 'c:project-all')
})
