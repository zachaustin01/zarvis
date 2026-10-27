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
})

test('scoreSession: every token must hit name, project, branch, role or state', () => {
  const r = S('a', 'login fix', { project: 'webapp', branch: 'feat/auth', state: 'blocked', role: 'manager' })
  assert.ok(scoreSession('login', r))
  assert.ok(scoreSession('webapp auth', r))
  assert.ok(scoreSession('manager', r))
  assert.ok(scoreSession('needs', r, 'needs you'))
  assert.equal(scoreSession('login zzz', r), null)
})

test('search: ranks by score, modes filter, empty query lists sessions then commands', () => {
  const sessions = [S('a', 'park the build'), S('b', 'docs')]
  const cmds = buildCommands(['zarvis', 'webapp'])
  const all = search('', sessions, cmds)
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
  for (const k of ['h', 't', 'p', 'Tab', '/', 'g', 'G', 'm', 'w', 'v', 'Enter', 'i', 'r', 'P', 'u', 'd', 'z', 'a', 'n', 'c', 'C', 'b', 'e', '?']) assert.ok(keys.has(k), `command for ${k}`)
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
