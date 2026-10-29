import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseLine, createUsageScanner, E } from '../lib/usage.mjs'
import { DEFAULT_PRICES, priceFor, costOf, tierFor, parseOverrides, loadPricing, baseModelId } from '../lib/pricing.mjs'
import { buildCosts, rangeStart, dayOf, daysIn, normalizeRange } from '../lib/costs.mjs'
import { readTags, setTag, clearTag, resolveProject, cleanProject } from '../lib/project-tags.mjs'
import { runCosts, formatReport, parseArgs } from '../lib/costs-cli.mjs'
import { runProject } from '../lib/project-cli.mjs'
import { buildLookup } from '../lib/lookup.mjs'
import { renderRoster } from '../lib/roster.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zarvis-costs-'))
const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
// A local-time moment: day buckets are local days, so the fixtures are built from local components.
const at = (d, h = 12) => new Date(2030, 0, d, h, 0, 0).getTime()
const NOW = at(20)

/** One synthetic assistant line. */
function line({ msg = 'm1', req = 'r1', model = 'claude-sonnet-5-5', ts = NOW, input = 10, output = 5, cacheRead = 0, cc, cw, cwd = '/work/alpha', type = 'assistant' } = {}) {
  const usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cw ?? (cc ? (cc.e5 || 0) + (cc.e1 || 0) : 0) }
  if (cc) usage.cache_creation = { ephemeral_5m_input_tokens: cc.e5 || 0, ephemeral_1h_input_tokens: cc.e1 || 0 }
  return JSON.stringify({ type, timestamp: new Date(ts).toISOString(), requestId: req, cwd, uuid: `${msg}-${req}-${output}`, message: { id: msg, model, usage } })
}
function transcripts(files) {
  const root = tmp()
  for (const [rel, lines] of Object.entries(files)) {
    const f = path.join(root, 'enc-folder', rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, lines.join('\n') + '\n')
  }
  return root
}
const scan = async (root) => {
  const s = createUsageScanner({ root })
  await s.refresh()
  return s
}
const sum = (snap, sid) => {
  const s = snap.find((x) => x.sessionId === sid)
  return s ? s.entries.reduce((a, e) => a + e[E.input] + e[E.output] + e[E.cacheRead] + e[E.cw5] + e[E.cw1], 0) : 0
}
const prices = { ...DEFAULT_PRICES }

test('parseLine: cache writes split 5m / 1h when the usage object has the breakdown, else all 5m', () => {
  const a = parseLine(line({ cc: { e5: 100, e1: 40 } }))
  assert.deepEqual([a.entry[E.cw5], a.entry[E.cw1]], [100, 40])
  const b = parseLine(line({ cw: 70 }))
  assert.deepEqual([b.entry[E.cw5], b.entry[E.cw1]], [70, 0])
})

test('parseLine: malformed lines, other record types, synthetic models and missing usage are skipped, never thrown', () => {
  for (const bad of ['', 'not json "usage"', '{"usage":', line({ type: 'user' }), line({ model: '<synthetic>' }), JSON.stringify({ type: 'assistant', message: { model: 'x' } }), '{"type":"assistant","message":{"usage":"nope"}}']) assert.equal(parseLine(bad), null, bad)
  assert.equal(parseLine('{"type":"assistant","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":"x","output_tokens":-3}},"timestamp":"nope"}').entry[E.output], 0)
})

test('a streamed message repeated on several lines counts once (message id + request id), the largest output winning', async () => {
  const root = transcripts({
    [`${id(1)}.jsonl`]: [line({ msg: 'a', req: 'r1', output: 5 }), line({ msg: 'a', req: 'r1', output: 40 }), line({ msg: 'a', req: 'r1', output: 40 }), line({ msg: 'b', req: 'r2', output: 7 }), 'garbage {', line({ msg: 'a', req: 'r9', output: 3 })],
  })
  const snap = (await scan(root)).snapshot()
  assert.equal(snap[0].entries.length, 3) // a|r1, b|r2, a|r9 (same message id, a different request)
  assert.equal(snap[0].entries.filter((e) => e[E.output] === 40).length, 1)
  assert.equal(sum(snap, id(1)), 3 * 10 + 40 + 7 + 3)
})

test("a subagent transcript counts for its session, and a replay of the same message in a resumed session counts once, for the session that began first", async () => {
  const root = transcripts({
    [`${id(1)}.jsonl`]: [line({ msg: 'a', req: 'r1', ts: at(1) }), line({ msg: 'b', req: 'r2', ts: at(2) })],
    [`${id(1)}/subagents/agent-x.jsonl`]: [line({ msg: 's', req: 'rs', ts: at(2), output: 100 })],
    // a resumed session replays a and b, then adds c
    [`${id(2)}.jsonl`]: [line({ msg: 'a', req: 'r1', ts: at(1) }), line({ msg: 'b', req: 'r2', ts: at(2) }), line({ msg: 'c', req: 'r3', ts: at(3) })],
  })
  const snap = (await scan(root)).snapshot()
  assert.equal(snap.find((s) => s.sessionId === id(1)).entries.length, 3)
  assert.equal(snap.find((s) => s.sessionId === id(2)).entries.length, 1)
  assert.equal(snap.reduce((n, s) => n + s.entries.length, 0), 4)
})

test('rescans are incremental: appended lines are added, a half-written last line waits for its newline, a shrunk file restarts', async () => {
  const root = transcripts({ [`${id(1)}.jsonl`]: [line({ msg: 'a', req: 'r1' })] })
  const file = path.join(root, 'enc-folder', `${id(1)}.jsonl`)
  const s = await scan(root)
  assert.equal(s.snapshot()[0].entries.length, 1)
  const half = line({ msg: 'b', req: 'r2' })
  fs.appendFileSync(file, half.slice(0, 30))
  await s.refresh()
  assert.equal(s.snapshot()[0].entries.length, 1)
  fs.appendFileSync(file, half.slice(30) + '\n' + line({ msg: 'c', req: 'r3' }) + '\n')
  await s.refresh()
  assert.equal(s.snapshot()[0].entries.length, 3)
  fs.writeFileSync(file, line({ msg: 'z', req: 'rz' }) + '\n')
  await s.refresh()
  assert.equal(s.snapshot()[0].entries.length, 1)
  fs.rmSync(file)
  await s.refresh()
  assert.equal(s.snapshot().length, 0)
})

test('pricing: exact id, date suffix ignored, family prefix flagged, unknown is unpriced', () => {
  assert.equal(priceFor('claude-opus-5-5').key, 'claude-opus-5-5')
  assert.equal(priceFor('claude-haiku-4-5-20251001').key, 'claude-haiku-4-5')
  assert.equal(priceFor('claude-haiku-4-5-20251001').match, 'exact')
  assert.equal(baseModelId('Claude-Sonnet-5-5[1m]'), 'claude-sonnet-5-5')
  const fam = priceFor('claude-opus-5-9')
  assert.deepEqual([fam.key, fam.match], ['claude-opus-5', 'family'])
  assert.equal(priceFor('claude-opus-5-5-20300101').key, 'claude-opus-5-5') // the newest id wins over the shorter family
  for (const m of ['gpt-4', 'claude-3-opus-20240229', '', null, 'claude']) assert.equal(priceFor(m), null, String(m))
})

test('pricing: cost is tokens x each rate per million, per type; the Haiku 5.5 long-prompt tier applies per request', () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }
  assert.equal(costOf(t, prices['claude-opus-5-5']), 4 + 20 + 0.2 + 5 + 8)
  assert.equal(costOf(t, prices['claude-fable-5-1']), 10 + 50 + 0.25 + 12.5 + 20)
  const h = prices['claude-haiku-5-5']
  assert.equal(tierFor(h, 100000), h)
  assert.equal(tierFor(h, 100001), h.over)
  assert.equal(costOf({ input: 1_000_000 }, tierFor(h, 200000)), 0.5)
  assert.equal(tierFor(prices['claude-opus-5-5'], 5e6), prices['claude-opus-5-5']) // no tier: flat
})

test('pricing overrides: ~/.zarvis/pricing.json replaces a model; incomplete or junk entries are ignored', async () => {
  const home = tmp()
  fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify({ 'claude-opus-5-5': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 }, 'my-model': { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 }, broken: { input: 1 }, neg: { input: -1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 } }))
  const p = await loadPricing(home)
  assert.equal(p.prices['claude-opus-5-5'].output, 2)
  assert.equal(priceFor('my-model', p.prices).match, 'exact')
  assert.deepEqual(p.overridden.sort(), ['claude-opus-5-5', 'my-model'])
  assert.deepEqual(parseOverrides([1]), {})
  assert.equal((await loadPricing(tmp())).overridden.length, 0) // no file: defaults
  fs.writeFileSync(path.join(home, 'pricing.json'), '{nope')
  assert.equal((await loadPricing(home)).overridden.length, 0)
})

const usageOf = (sessionId, entries, cwd = '/work/alpha') => ({ sessionId, cwd, entries })
const ent = (ts, model, [input, output, cacheRead, cw5, cw1]) => [ts, model, input, output, cacheRead, cw5, cw1]
const facts = (o) => new Map(Object.entries(o))

test('buildCosts: per-model dollars, token types and the 5m / 1h cache split are priced separately', () => {
  const u = usageOf(id(1), [ent(NOW, 'claude-opus-5-5', [1000, 2000, 30000, 4000, 5000]), ent(NOW, 'claude-sonnet-5-5', [1000, 1000, 0, 0, 0])])
  const r = buildCosts([u], facts({ [id(1)]: { project: 'alpha', role: 'worker' } }), { prices, range: 'all', now: NOW })
  const opus = (1000 * 4 + 2000 * 20 + 30000 * 0.2 + 4000 * 5 + 5000 * 8) / 1e6
  const sonnet = (1000 * 2 + 1000 * 10) / 1e6
  const p = r.projects[0]
  assert.equal(p.project, 'alpha')
  assert.ok(Math.abs(p.cost - (opus + sonnet)) < 1e-12)
  assert.deepEqual(p.tokens, { input: 2000, output: 3000, cacheRead: 30000, cacheWrite5m: 4000, cacheWrite1h: 5000 })
  assert.deepEqual(p.models.map((m) => m.model), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  assert.ok(Math.abs(p.models[0].cost - opus) < 1e-12)
  assert.equal(r.totals.totalTokens, 2000 + 3000 + 30000 + 4000 + 5000)
})

test('buildCosts: an unpriced model keeps its tokens, adds no dollars, and is listed apart', () => {
  const u = usageOf(id(1), [ent(NOW, 'claude-sonnet-5-5', [1000000, 0, 0, 0, 0]), ent(NOW, 'claude-mystery-9-20300101', [500, 500, 0, 0, 0])])
  const r = buildCosts([u], facts({}), { prices, range: 'all', now: NOW })
  assert.equal(r.totals.cost, 2)
  assert.equal(r.totals.unpricedTokens, 1000)
  assert.equal(r.totals.totalTokens, 1001000)
  assert.deepEqual(r.unpriced, [{ model: 'claude-mystery-9', tokens: 1000, messages: 1 }])
  const m = r.projects[0].models.find((x) => x.model === 'claude-mystery-9-20300101')
  assert.deepEqual([m.priced, m.cost], [false, 0])
  assert.equal(r.projects[0].unpricedTokens, 1000)
  assert.deepEqual(buildCosts([usageOf(id(1), [ent(NOW, 'claude-opus-5-9', [1000000, 0, 0, 0, 0])])], facts({}), { prices, range: 'all', now: NOW }).approx, [{ model: 'claude-opus-5-9', as: 'claude-opus-5' }])
})

test('buildCosts: the Haiku 5.5 long-prompt tier prices a request by its whole prompt, cache included', () => {
  const small = ent(NOW, 'claude-haiku-5-5', [1000, 0, 90000, 0, 0])
  const big = ent(NOW, 'claude-haiku-5-5', [1000, 0, 120000, 0, 0])
  const r = buildCosts([usageOf(id(1), [small, big])], facts({}), { prices, range: 'all', now: NOW })
  assert.ok(Math.abs(r.totals.cost - ((1000 * 0.1 + 90000 * 0.01 + 1000 * 0.5 + 120000 * 0.05) / 1e6)) < 1e-12)
})

test('ranges bucket by local day: today, 7d (six days back), 30d, all; the daily series is zero-filled', () => {
  assert.equal(rangeStart('today', NOW), at(20, 0))
  assert.equal(rangeStart('7d', NOW), at(14, 0))
  assert.equal(rangeStart('30d', NOW), new Date(2029, 11, 22).getTime())
  assert.equal(rangeStart('all', NOW), 0)
  assert.equal(normalizeRange('nope'), '7d')
  assert.deepEqual(daysIn(at(18, 0), NOW), ['2030-01-18', '2030-01-19', '2030-01-20'])
  assert.equal(dayOf(at(5, 23)), '2030-01-05')
  const m = 'claude-sonnet-5-5'
  const u = usageOf(id(1), [ent(at(20, 0) + 1, m, [1e6, 0, 0, 0, 0]), ent(at(19, 23), m, [1e6, 0, 0, 0, 0]), ent(at(14, 0), m, [1e6, 0, 0, 0, 0]), ent(at(13, 23), m, [1e6, 0, 0, 0, 0]), ent(at(1), m, [1e6, 0, 0, 0, 0])])
  const cost = (range) => buildCosts([u], facts({}), { prices, range, now: NOW }).totals.cost
  assert.deepEqual(['today', '7d', '30d', 'all'].map(cost), [2, 6, 10, 10])
  const r = buildCosts([u], facts({}), { prices, range: '7d', now: NOW })
  assert.deepEqual(r.projects[0].days.map((d) => [d.day, d.cost]), [['2030-01-14', 2], ['2030-01-15', 0], ['2030-01-16', 0], ['2030-01-17', 0], ['2030-01-18', 0], ['2030-01-19', 2], ['2030-01-20', 2]])
})

test('buildCosts: manager vs worker split, sessions ranked by cost, project filter', () => {
  const m = 'claude-sonnet-5-5'
  const us = [usageOf(id(1), [ent(NOW, m, [1e6, 0, 0, 0, 0])]), usageOf(id(2), [ent(NOW, m, [3e6, 0, 0, 0, 0])]), usageOf(id(3), [ent(NOW, m, [1e6, 0, 0, 0, 0])], '/work/beta')]
  const f = facts({ [id(1)]: { project: 'alpha', role: 'manager', name: 'Mgr' }, [id(2)]: { project: 'alpha', role: 'worker', name: 'Wrk', managerId: id(1) }, [id(3)]: { project: 'beta', role: 'interface' } })
  const r = buildCosts(us, f, { prices, range: 'all', now: NOW })
  assert.deepEqual(r.projects.map((p) => p.project), ['alpha', 'beta'])
  assert.deepEqual([r.projects[0].roles.manager.cost, r.projects[0].roles.worker.cost, r.projects[1].roles.other.cost], [2, 6, 2])
  assert.deepEqual(r.projects[0].top.map((s) => s.name), ['Wrk', 'Mgr'])
  assert.deepEqual([r.totals.roles.manager, r.totals.roles.worker, r.totals.roles.other, r.totals.sessions], [2, 6, 2, 3])
  assert.deepEqual(buildCosts(us, f, { prices, range: 'all', now: NOW, project: 'BETA' }).projects.map((p) => p.project), ['beta'])
})

test('project resolution order: the session\'s own tag, then its manager\'s tag, then the folder name', () => {
  const tags = { [id(1)]: { project: 'own' }, [id(9)]: { project: 'mgr-tag' } }
  assert.deepEqual(resolveProject(id(1), { managerId: id(9), derived: 'folder', tags }), { project: 'own', source: 'explicit' })
  assert.deepEqual(resolveProject(id(2), { managerId: id(9), derived: 'folder', tags }), { project: 'mgr-tag', source: 'manager' })
  assert.deepEqual(resolveProject(id(2), { managerId: id(8), derived: 'folder', tags }), { project: 'folder', source: 'derived' })
  assert.deepEqual(resolveProject(id(2), { derived: 'folder' }), { project: 'folder', source: 'derived' })
  // and the cost model uses it
  const m = 'claude-sonnet-5-5'
  const us = [usageOf(id(1), [ent(NOW, m, [1e6, 0, 0, 0, 0])]), usageOf(id(2), [ent(NOW, m, [1e6, 0, 0, 0, 0])]), usageOf(id(3), [ent(NOW, m, [1e6, 0, 0, 0, 0])])]
  const f = facts({ [id(1)]: { project: 'f1' }, [id(2)]: { project: 'f2', managerId: id(9) }, [id(3)]: { project: 'f3' } })
  const r = buildCosts(us, f, { prices, tags, range: 'all', now: NOW })
  assert.deepEqual(r.projects.map((p) => [p.project, p.explicit]).sort(), [['f3', false], ['mgr-tag', false], ['own', true]])
})

test('tag file: set, clear, bad files and names', async () => {
  const home = tmp()
  assert.deepEqual(await readTags(home), {})
  await setTag(home, id(1), '  My\n Project  ', id(2), 5)
  assert.deepEqual(await readTags(home), { [id(1)]: { project: 'My Project', by: id(2), at: 5 } })
  await assert.rejects(setTag(home, 'x', 'p'), /bad session id/)
  await assert.rejects(setTag(home, id(1), '  \n '), /empty/)
  assert.equal(cleanProject('a'.repeat(100)).length, 60)
  assert.equal((await clearTag(home, id(1))).project, 'My Project')
  assert.equal(await clearTag(home, id(1)), null)
  fs.writeFileSync(path.join(home, 'projects.json'), '[1,2')
  assert.deepEqual(await readTags(home), {})
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ [id(1)]: 'plain', bad: { project: 'x' }, [id(2)]: { project: '' } }))
  assert.deepEqual(Object.keys(await readTags(home)), [id(1)])
})

// ---- the lookup / CLIs, on a synthetic world ----
const rec = (n, extra = {}) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `Title ${n}`, cwd: `/work/proj${n}`, branch: `br${n}`, lastActivityAt: NOW - 60_000, ...extra })
const world = (extra = {}) => ({
  records: [rec(1, { title: 'The Manager' }), rec(2, { title: 'The Worker' }), rec(3, { title: 'Loner', cwd: '/work/lone/.claude/worktrees/wt', originCwd: '/work/lone' })],
  state: { overlays: {}, roles: {}, parked: {}, done: {} },
  roles: { [id(1)]: { role: 'manager' }, [id(2)]: { role: 'worker', parent: id(1) } },
  markers: [],
  working: [],
  tasks: {},
  now: NOW,
  branchOf: async () => '',
  ...extra,
})
const capture = () => {
  const out = []
  const errs = []
  return { out, errs, log: (s) => out.push(s), err: (s) => errs.push(s) }
}

test('lookup carries the effective project and where it came from; worktrees roll up to the repo folder', async () => {
  const list = await buildLookup(world({ projectTags: { [id(1)]: { project: 'big-thing' } } }))
  const by = (n) => list.find((e) => e.sessionId === id(n))
  assert.deepEqual([by(1).project, by(1).projectSource, by(1).folderProject], ['big-thing', 'explicit', 'proj1'])
  assert.deepEqual([by(2).project, by(2).projectSource, by(2).folderProject], ['big-thing', 'manager', 'proj2'])
  assert.deepEqual([by(3).project, by(3).projectSource], ['lone', 'derived'])
  assert.equal((await buildLookup(world({ projectTags: { [id(2)]: { project: 'mine' } } }))).find((e) => e.sessionId === id(2)).project, 'mine')
})

test('the roster file marks a tagged project', () => {
  const w = { name: 'W', state: 'idle', project: 'big', projectSource: 'manager', branch: '', sessionId: id(2), tasks: {} }
  const t = { interface: [], managers: [{ name: 'M', sessionId: id(1), project: 'big', projectSource: 'explicit', state: 'idle', children: [w] }], orphans: [], unclassified: [] }
  assert.match(renderRoster(t, [], NOW), /project big \(tagged\)/)
})

test('npm run project: set by id and by name, a manager\'s workers follow, clear, list, refusals', async () => {
  const home = tmp()
  const w = world()
  const run = async (...argv) => {
    const c = capture()
    const code = await runProject(argv, { home, world: w, now: NOW, log: c.log, err: c.err })
    return { code, text: c.out.join('\n'), err: c.errs.join('\n') }
  }
  let r = await run('set', id(1), 'big-thing', '--by', id(2))
  assert.equal(r.code, 0)
  assert.match(r.text, /tagged The Manager \(manager\) with project big-thing\. Its workers follow it/)
  assert.deepEqual(await readTags(home), { [id(1)]: { project: 'big-thing', by: id(2), at: NOW } })
  r = await run('set', 'the worker', 'other')
  assert.equal(r.code, 0)
  assert.equal((await readTags(home))[id(2)].project, 'other')
  r = await run('list')
  assert.match(r.text, /big-thing — The Manager \(manager\) — folder proj1/)
  assert.equal(JSON.parse((await run('list', '--json')).text).tags.length, 2)
  r = await run('clear', 'local_' + id(2))
  assert.equal(r.code, 0)
  assert.match(r.text, /its project is now proj2/)
  assert.equal((await run('clear', id(2))).code, 1)
  for (const argv of [['set', id(1)], ['set', 'nobody-by-that-name', 'x'], ['frobnicate'], ['set', id(1), 'a', 'b'], ['set', id(1), 'x', '--by', 'bad id!']]) assert.equal((await run(...argv)).code, 1, argv.join(' '))
  assert.equal(Object.keys(await readTags(home)).length, 1) // nothing else got written
})

test('npm run costs: the same numbers as the model, per project, with honesty lines; --json; refusals', async () => {
  const root = transcripts({
    [`${id(1)}.jsonl`]: [line({ msg: 'a', req: 'r1', model: 'claude-sonnet-5-5', input: 1_000_000, output: 0, ts: NOW })],
    [`${id(2)}.jsonl`]: [line({ msg: 'b', req: 'r2', model: 'claude-sonnet-5-5', input: 0, output: 1_000_000, ts: NOW }), line({ msg: 'c', req: 'r3', model: 'claude-mystery-9', input: 777, output: 0, ts: NOW })],
  })
  const w = world({ projectTags: { [id(1)]: { project: 'big-thing' } } })
  const go = async (...argv) => {
    const c = capture()
    const code = await runCosts(argv, { world: w, scanner: createUsageScanner({ root }), home: tmp(), now: NOW, log: c.log, err: c.err })
    return { code, text: c.out.join('\n'), err: c.errs.join('\n') }
  }
  const r = await go('--range', 'today')
  assert.equal(r.code, 0)
  assert.match(r.text, /API-equivalent estimate/)
  assert.match(r.text, /big-thing \(tagged\) — \$12\.00 · 2\.0M tokens · 2 sessions/) // manager + its worker, who follows the tag
  assert.match(r.text, /Unpriced: 777 tokens on claude-mystery-9/)
  assert.match(r.text, /managers \$2\.00, workers \$10\.0/)
  assert.match(r.text, /platform\.claude\.com\/docs\/en\/about-claude\/pricing \(checked 2026-10-29\)/)
  const j = JSON.parse((await go('--range', 'all', '--json')).text)
  assert.equal(j.totals.cost, 12)
  assert.equal(j.projects.find((p) => p.project === 'big-thing').sessions, 2)
  assert.equal(JSON.parse((await go('--project', 'nothing', '--json')).text).projects.length, 0)
  assert.equal((await go('--range', 'fortnight')).code, 1)
  assert.equal((await go('--wat')).code, 1)
  assert.equal(parseArgs(['--top', '2']).top, 2)
  assert.match(formatReport({ range: 'today', totals: { cost: 0, totalTokens: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, sessions: 0, roles: { manager: 0, worker: 0, other: 0 }, unpricedTokens: 0 }, projects: [], unpriced: [], approx: [], pricing: { source: 's', checked: 'd', overridden: [] } }), /No token usage/)
})

test('server: GET /api/costs returns the report for ?range, never touches the real home, and rejects nothing it should serve', async () => {
  const projects = transcripts({ [`${id(1)}.jsonl`]: [line({ msg: 'a', req: 'r1', model: 'claude-opus-5-5', input: 1_000_000, output: 0, ts: Date.now(), cwd: '/work/alpha' })] })
  const home = tmp()
  const desktop = tmp()
  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, ZARVIS_HOME: home, ZARVIS_PORT: String(port), ZARVIS_DESKTOP_SESSIONS: desktop, ZARVIS_CLI_PROJECTS: projects, ZARVIS_DRY_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((res, rej) => { p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res()); p.on('exit', () => rej(new Error('server exited'))) })
    const base = `http://127.0.0.1:${port}`
    const j = await (await fetch(`${base}/api/costs?range=today`)).json()
    assert.equal(j.range, 'today')
    assert.equal(j.totals.cost, 4)
    assert.deepEqual(j.projects.map((x) => x.project), ['alpha']) // derived from the transcript's cwd: no desktop record for it
    assert.equal(j.pricing.checked, '2026-10-29')
    assert.equal(j.scanning, null)
    assert.equal((await (await fetch(`${base}/api/costs?range=bogus`)).json()).range, '7d')
    assert.equal((await (await fetch(`${base}/api/costs?range=all&project=zzz`)).json()).projects.length, 0)
  } finally {
    p.kill()
  }
})

test('manager rollup: a manager row is the manager plus every worker attached to it (parked and old ones too), per time frame', () => {
  const m = 'claude-sonnet-5-5'
  const M = 1e6 // $2 per million input tokens
  const us = [
    usageOf(id(1), [ent(at(20), m, [M, 0, 0, 0, 0]), ent(at(10), m, [M, 0, 0, 0, 0])]),
    usageOf(id(2), [ent(at(20), m, [2 * M, 0, 0, 0, 0])]), // live worker
    usageOf(id(3), [ent(at(10), m, [3 * M, 0, 0, 0, 0])]), // a parked worker, active only 10 days ago
    usageOf(id(4), [ent(at(20), m, [M, 0, 0, 0, 0])], '/work/beta'), // another manager's worker, in another project
    usageOf(id(5), [ent(at(20), m, [M, 0, 0, 0, 0])]), // no manager
    usageOf(id(6), [ent(at(20), m, [M, 0, 0, 0, 0])]), // the other manager itself
  ]
  const f = facts({
    [id(1)]: { project: 'alpha', role: 'manager', name: 'Alpha mgr' },
    [id(2)]: { project: 'alpha', role: 'worker', name: 'W live', managerId: id(1) },
    [id(3)]: { project: 'alpha', role: 'worker', name: 'W parked', managerId: id(1), parked: true },
    [id(4)]: { project: 'beta', role: 'worker', name: 'W beta', managerId: id(6) },
    [id(5)]: { project: 'alpha', role: 'unclassified', name: 'Loose' },
    [id(6)]: { project: 'beta', role: 'manager', name: 'Beta mgr' },
  })
  const run = (range, extra = {}) => buildCosts(us, f, { prices, range, now: NOW, ...extra })
  const all = run('all')
  const a = all.managers.find((g) => g.managerId === id(1))
  assert.deepEqual([a.name, a.cost, a.sessions, a.roles.manager.cost, a.roles.worker.cost, a.roles.worker.sessions], ['Alpha mgr', 2 * 7, 3, 4, 10, 2])
  assert.equal(a.top.find((s) => s.sessionId === id(3)).parked, true)
  const b = all.managers.find((g) => g.managerId === id(6))
  assert.deepEqual([b.cost, b.projects], [4, ['beta']])
  // spend with no manager above it is kept out of the manager rows, in two buckets: unmanaged workers, and the rest
  assert.deepEqual(all.managers.filter((g) => g.kind !== 'manager').map((g) => [g.kind, g.name, g.managerId, g.cost]), [['unclassified', 'Unclassified sessions', '', 2]])
  const un = buildCosts([...us, usageOf(id(9), [ent(at(20), m, [M, 0, 0, 0, 0])])], { ...Object.fromEntries(f), [id(9)]: { project: 'alpha', role: 'worker', name: 'Stray' } }, { prices, range: 'all', now: NOW })
  assert.deepEqual(un.managers.find((g) => g.kind === 'unmanaged').top.map((x) => x.name), ['Stray'])
  assert.deepEqual(un.managers.filter((g) => g.kind === 'manager').map((g) => g.name).sort(), ['Alpha mgr', 'Beta mgr'])
  const iface = buildCosts([usageOf(id(9), [ent(at(20), m, [M, 0, 0, 0, 0])])], facts({ [id(9)]: { project: 'alpha', role: 'interface', name: 'Iface' } }), { prices, range: 'all', now: NOW })
  assert.deepEqual(iface.managers.map((g) => [g.kind, g.name]), [['interface', 'Interface']]) // its own row, not folded into 'unclassified'
  assert.equal(all.managers.reduce((n, g) => n + g.cost, 0), all.totals.cost) // every dollar lands in exactly one manager row
  // time frame: the parked worker's spend (10 days ago) is outside 7d but inside 30d
  assert.equal(run('7d').managers.find((g) => g.managerId === id(1)).cost, 2 + 4)
  assert.equal(run('30d').managers.find((g) => g.managerId === id(1)).cost, 14)
  assert.equal(run('today').managers.find((g) => g.managerId === id(1)).cost, 6)
  // filters: by manager name, id prefix; combined with a project
  assert.deepEqual(run('all', { manager: 'beta mgr' }).managers.map((g) => g.name), ['Beta mgr'])
  assert.deepEqual(run('all', { manager: id(1).slice(0, 8) }).managers.map((g) => g.name), ['Alpha mgr'])
  assert.equal(run('all', { manager: 'Alpha mgr', project: 'beta' }).managers.length, 0)
  // a worker whose manager has no facts still rolls up under it
  const orphan = buildCosts([usageOf(id(7), [ent(NOW, m, [M, 0, 0, 0, 0])])], facts({ [id(7)]: { project: 'x', role: 'worker', name: 'Lost', managerId: id(8) } }), { prices, range: 'all', now: NOW })
  assert.match(orphan.managers[0].name, /^manager 88888888/)
})

test('npm run costs --group manager / --manager: manager rows with their workers', async () => {
  const root = transcripts({
    [`${id(1)}.jsonl`]: [line({ msg: 'a', req: 'r1', input: 1_000_000, output: 0, ts: NOW })],
    [`${id(2)}.jsonl`]: [line({ msg: 'b', req: 'r2', input: 0, output: 1_000_000, ts: NOW })],
  })
  const w = world()
  const go = async (...argv) => {
    const c = capture()
    const code = await runCosts(argv, { world: w, scanner: createUsageScanner({ root }), home: tmp(), now: NOW, log: c.log, err: c.err })
    return { code, text: c.out.join('\n'), err: c.errs.join('\n') }
  }
  const r = await go('--range', 'today', '--group', 'manager')
  assert.match(r.text, /by manager \(each with all its workers, parked ones included\)/)
  assert.match(r.text, /The Manager — \$12\.00 · 2\.0M tokens · 2 sessions/)
  assert.match(r.text, /spend: the manager itself \$2\.00, workers \$10\.00/)
  const j = JSON.parse((await go('--manager', 'the manager', '--json')).text)
  assert.deepEqual(j.managers.map((g) => g.name), ['The Manager'])
  assert.match((await go('--manager', 'the manager')).text, /by manager/) // --manager implies the grouping
  assert.equal((await go('--group', 'team')).code, 1)
})

// ---- the page ----
import { usd, tok, familyOf, modelLabel, mixSegments, dayBars, stepRange, rangeOf, share, stepIndex, RANGES, dayLabel } from '../public/costs.js'
import { COMMANDS } from '../public/palette.js'
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

test('costs.js: formatting, model colours and mix, bar maths', () => {
  assert.deepEqual([usd(0), usd(0.0123), usd(5.678), usd(123.4), usd(12345.6)], ['$0', '$0.012', '$5.68', '$123', '$12,346'])
  assert.deepEqual([tok(12), tok(1500), tok(2_500_000), tok(3_100_000_000)], ['12', '1.5k', '2.5M', '3.10B'])
  assert.deepEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'gpt-4'].map(familyOf), ['opus', 'fable', 'haiku', 'other'])
  assert.deepEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'weird'].map(modelLabel), ['opus 5.5', 'haiku 4.5', 'sonnet 5', 'weird'])
  const segs = mixSegments([{ model: 'claude-opus-5-5', cost: 3, totalTokens: 10, priced: true }, { model: 'claude-mystery-9', cost: 0, totalTokens: 99, priced: false }, { model: 'claude-sonnet-5-5', cost: 1, totalTokens: 5, priced: true }])
  assert.deepEqual(segs.map((g) => [g.family, Math.round(g.pct)]), [['opus', 75], ['sonnet', 25]]) // by dollars; an unpriced model has none to show
  assert.equal(mixSegments([{ model: 'x', cost: 0, totalTokens: 5, priced: false }])[0].family, 'other')
  assert.deepEqual(mixSegments([]), [])
  assert.deepEqual(dayBars([{ cost: 1 }, { cost: 4 }, { cost: 0 }]), [0.25, 1, 0])
  assert.deepEqual(dayBars([{ cost: 0 }]), [0])
  assert.deepEqual([share(1, 4), share(5, 0), share(9, 3)], [25, 0, 100])
  assert.deepEqual([stepRange('7d', 1), stepRange('all', 1), stepRange('today', -1), stepRange('7d', -1)], ['30d', 'all', 'today', 'today'])
  assert.equal(rangeOf('bogus').id, '7d')
  assert.deepEqual(RANGES.map((r) => r.id), ['today', '7d', '30d', 'all'])
  assert.deepEqual([stepIndex(0, 3, -1), stepIndex(2, 3, 1), stepIndex(1, 0, 1)], [0, 2, 0])
  assert.equal(typeof dayLabel('2030-01-05'), 'string')
})

test('wiring: $ opens Costs, v groups, - = range, Esc backs out, palette commands, key sheet, README, skills, no scrollbars', () => {
  const app = read('public/app.js')
  const html = read('public/index.html')
  const css = read('public/app.css')
  const readme = read('README.md')
  assert.match(app, /e\.key === '\$'\) setView\('costs'\)/)
  assert.match(app, /e\.key === 'v' && view === 'costs'/)
  assert.match(app, /if \(view === 'costs'\) return setCostRange\(stepRange\(costRange, dir\), dir\)/)
  assert.match(app, /view === 'costs' && !help\.classList\.contains\('on'\)[^\n]*'Escape'/) // before the generic Esc that closes the key sheet
  assert.ok(app.indexOf("view === 'costs' && !help") < app.indexOf("if (e.key === 'Escape') return help"))
  for (const id of ['view-costs', 'costs-today', 'costs-7d', 'costs-30d', 'costs-all', 'costs-by-manager', 'costs-by-project']) {
    assert.ok(COMMANDS.some((c) => c.id === id), `palette ${id}`)
    assert.match(app, new RegExp(`'${id}': `))
  }
  assert.match(html, /data-view="costs"/)
  assert.match(html, /<kbd>\$<\/kbd><\/span><span class="kd">Costs/)
  assert.match(html, /Cycle Queue, Roles, Parked, Schedule, Costs/)
  assert.match(html, /API-equivalent estimate, not a bill/)
  // the page follows the UI rules: paginate() not scrollbars, change-only writes, effects outside #list, reduced motion respected (no animation here)
  assert.match(app, /paginate\(heights, kids\.map\(\(\) => false\), avail\)/)
  assert.match(app, /function setHtml\(slot, el, html\) \{\n  if \(csHtml\[slot\] === html\) return/)
  assert.doesNotMatch(css.slice(css.indexOf('Costs view')), /overflow(-[xy])?:\s*(auto|scroll)|animation:|transition:/)
  assert.match(app, /if \(view === 'costs'\) return \/\/ so does the Costs view/) // a push never redraws it
  assert.match(readme, /## Costs/)
  assert.match(readme, /`\$` costs/)
  assert.match(readme, /npm run costs/)
  assert.match(readme, /npm run project/)
  assert.match(readme, /API-equivalent estimate/)
  assert.match(readme, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/)
  assert.match(read('package.json'), /"costs": "node scripts\/costs\.mjs"/)
  assert.match(read('package.json'), /"project": "node scripts\/project\.mjs"/)
  for (const skill of ['interface', 'manager', 'worker']) assert.match(read(`skills/zarvis-${skill}/SKILL.md`), /scripts\/project\.mjs/, skill)
  for (const skill of ['interface', 'manager']) assert.match(read(`skills/zarvis-${skill}/SKILL.md`), /scripts\/costs\.mjs/, skill)
})

test('the Costs view defaults to manager rows plus interface and unclassified rows, with a chip for unmanaged workers', () => {
  const app = read('public/app.js')
  assert.match(app, /let costGroup = 'manager'/)
  assert.match(app, /costs\?\.managers\.filter\(\(g\) => g\.kind !== 'unmanaged'\)/) // manager, interface and unclassified rows
  assert.match(app, /const csBuckets = /)
  assert.match(app, /\$\('#csSum'\)\.addEventListener\('click'/)
  assert.match(app, /d\.managers\.filter\(\(g\) => g\.kind === 'manager'\)/) // the cards' chip counts managers only
})

test('a manager card carries a cost chip: manager plus all its workers over 7 days, a click opens Costs on that manager', () => {
  const app = read('public/app.js')
  assert.match(app, /function costChip\(r\) \{\n  const c = r\.role === 'manager' \? mgrCosts\.get\(r\.sessionId\) : null/)
  assert.match(app, /const clock = clockChip\(r\.sessionId\) \+ costChip\(r\)/)
  assert.match(app, /fetch\('\/api\/costs\?range=7d'\)/)
  assert.match(app, /const kk = e\.target\.closest\('\.lkk'\)\n\s+if \(kk\) return openManagerCost\(kk\.dataset\.m\)/) // before the schedule chip's handler
  assert.ok(app.indexOf('let mgrCosts') < app.indexOf('function costChip')) // declared before any render can use it
})

test('Costs view: unclassified and unmanaged sessions can be classified in place (buttons, a "worker of" picker, c + i/m/w/x)', () => {
  const app = read('public/app.js')
  assert.match(app, /async function classifySel\(role\) \{\n  if \(view === 'costs'\) return classifyCostSel\(role\)/) // the existing c second-key reaches it
  assert.match(app, /post\('\/api\/classify', \{ sessionId: id, role, \.\.\.\(parent \? \{ parent \} : \{\}\) \}\)/)
  assert.match(app, /proj\.kind === 'unclassified' \|\| proj\.kind === 'unmanaged'\) : groupRowHtml/)
  assert.match(app, /data-role="interface"[^]*data-role="manager"/)
  assert.match(app, /classifyCost\(row\.dataset\.id, 'worker', sel2\.value\)/)
  assert.match(read('public/index.html'), /<kbd>c<\/kbd> then <kbd>i<\/kbd> <kbd>m<\/kbd> <kbd>w<\/kbd> classifies/)
})

test('Costs view: a session can be renamed in a drill-down (r or the rename chip), reusing /api/rename and the app\'s rename box', () => {
  const app = read('public/app.js')
  assert.match(app, /e\.key === 'r' && view === 'costs'\) \{ e\.preventDefault\(\); startCostRename\(\) \}/)
  assert.ok(app.indexOf("e.key === 'r' && view === 'costs'") < app.indexOf("e.key === 'r' && items().length"))
  assert.match(app, /if \(renaming && view === 'costs'\) \{\n    if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); commitCostRename\(\) \}/)
  assert.match(app, /post\('\/api\/rename', \{ sessionId: id, name: val \}\)/)
  assert.match(app, /document\.activeElement\?\.id === 'renIn'\) return/) // a live redraw keeps a half-typed name
  assert.match(app, /data-rename/)
})
