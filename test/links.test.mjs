import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanUrl, cleanLabel, parseLink, addLink, removeLink, readLinks, readAllLinks, clearLinks, linksFile, MAX_LINKS } from '../lib/links.mjs'
import { runLink, parseArgs } from '../lib/links-cli.mjs'
import { buildLookup } from '../lib/lookup.mjs'
import { runRoster } from '../lib/roster-cli.mjs'

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-links-'))
const A = id(1)

test('cleanUrl accepts http(s), including localhost, and normalises', () => {
  assert.equal(cleanUrl('https://dagster.example.com/runs/abc?x=1#top'), 'https://dagster.example.com/runs/abc?x=1#top')
  assert.equal(cleanUrl('http://localhost:3000'), 'http://localhost:3000/')
  assert.equal(cleanUrl('http://127.0.0.1:5000/a'), 'http://127.0.0.1:5000/a')
})

test('cleanUrl rejects javascript:, data:, file:, credentials, whitespace, control characters and huge input', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x.com/a', 'vbscript:x', '//evil.com', 'example.com', '',
    'https://user:pw@example.com/', 'https://user@example.com/', 'https://exa mple.com/', 'https://example.com/a b', ' https://example.com/', 'https://example.com/\n', 'https://example.com/\u0000', 'https://example.com/‮', 'https://',
    `https://example.com/${'a'.repeat(300)}`, null, undefined, 42, {}, ['https://a.com']]) {
    assert.equal(cleanUrl(bad), '', JSON.stringify(bad))
  }
  assert.equal(cleanUrl('x'.repeat(1_000_000)), '')
})

test('cleanLabel is one line and at most 60 characters', () => {
  assert.equal(cleanLabel('  Dagster\n\trun \u0000 now '), 'Dagster run now')
  assert.equal(cleanLabel('x'.repeat(500)).length, 60)
  assert.equal(cleanLabel(undefined), '')
})

test('parseLink validates and defaults the label to the host', () => {
  assert.deepEqual(parseLink({ url: 'https://a.example.com/x' }), { url: 'https://a.example.com/x', label: 'a.example.com' })
  assert.equal(parseLink({ url: 'javascript:1', label: 'x' }), null)
  assert.equal(parseLink(null), null)
})

test('add stores a link atomically (no tmp file left), honouring the home dir', async () => {
  const home = await tmp()
  const l = await addLink(home, A, 'https://a.example.com/run/1', 'Run  1')
  assert.deepEqual(l, { url: 'https://a.example.com/run/1', label: 'Run 1' })
  assert.deepEqual(await fsp.readdir(path.join(home, 'links')), [`${A}.json`])
  assert.deepEqual(await readLinks(home, A), [l])
})

test('the same URL again updates its label and moves to the end; no duplicates', async () => {
  const home = await tmp()
  await addLink(home, A, 'https://a.example.com/1', 'one')
  await addLink(home, A, 'https://a.example.com/2', 'two')
  await addLink(home, A, 'https://a.example.com/1', 'uno')
  assert.deepEqual((await readLinks(home, A)).map((l) => [l.url, l.label]), [['https://a.example.com/2', 'two'], ['https://a.example.com/1', 'uno']])
  await addLink(home, A, 'https://a.example.com/2') // no label: the old one stays
  assert.equal((await readLinks(home, A)).at(-1).label, 'two')
})

test('at most 8 links: the oldest drops', async () => {
  const home = await tmp()
  for (let i = 1; i <= MAX_LINKS + 3; i++) await addLink(home, A, `https://a.example.com/${i}`, `l${i}`)
  const ls = await readLinks(home, A)
  assert.equal(ls.length, MAX_LINKS)
  assert.equal(ls[0].label, 'l4')
  assert.equal(ls.at(-1).label, `l${MAX_LINKS + 3}`)
})

test('remove by URL or 1-based number; the last removal deletes the file', async () => {
  const home = await tmp()
  await addLink(home, A, 'https://a.example.com/1')
  await addLink(home, A, 'https://a.example.com/2')
  assert.equal((await removeLink(home, A, '1')).url, 'https://a.example.com/1')
  assert.equal(await removeLink(home, A, '5'), null)
  assert.equal(await removeLink(home, A, 'https://nope.example.com/'), null)
  assert.equal((await removeLink(home, A, 'https://a.example.com/2')).url, 'https://a.example.com/2')
  await assert.rejects(fsp.stat(linksFile(home, A)))
})

test('add refuses unsafe URLs and bad ids without writing', async () => {
  const home = await tmp()
  await assert.rejects(addLink(home, A, 'javascript:alert(1)'), { refusal: true })
  await assert.rejects(addLink(home, '../etc', 'https://a.example.com/'), { refusal: true })
  await assert.rejects(fsp.readdir(path.join(home, 'links')))
})

test('a corrupt, hostile or odd file yields only its valid links, never throws', async () => {
  const home = await tmp()
  await fsp.mkdir(path.join(home, 'links'))
  const w = (name, body) => fsp.writeFile(path.join(home, 'links', name), body)
  await w(`${A}.json`, '{not json')
  assert.deepEqual(await readLinks(home, A), [])
  await w(`${A}.json`, JSON.stringify({ links: [{ url: 'javascript:alert(1)', label: 'x' }, { url: 'https://u:p@a.com/' }, 'str', null, { url: 'https://ok.example.com/', label: 'ok\nline' }, { url: 'https://ok.example.com/', label: 'again' }] }))
  assert.deepEqual(await readLinks(home, A), [{ url: 'https://ok.example.com/', label: 'again' }])
  await w(`${id(2)}.json`, JSON.stringify({ links: 'nope' }))
  await w('not-an-id!.json', JSON.stringify({ links: [{ url: 'https://x.example.com/' }] }))
  assert.deepEqual(Object.keys(await readAllLinks(home)), [A])
  assert.deepEqual(await readLinks(home, '../x'), [])
  assert.deepEqual(await readAllLinks(path.join(home, 'missing')), {})
})

test('clearLinks removes a session file and tolerates none', async () => {
  const home = await tmp()
  await addLink(home, A, 'https://a.example.com/')
  await clearLinks(home, A)
  await clearLinks(home, A)
  assert.deepEqual(await readLinks(home, A), [])
})

// --- the CLI ---
async function cli(home, argv, extra = {}) {
  const out = []
  const err = []
  const code = await runLink(argv, { home, env: {}, log: (l) => out.push(l), err: (l) => err.push(l), ...extra })
  return { code, out, err }
}

test('parseArgs reads flags and rejects unknown ones', () => {
  assert.deepEqual(parseArgs(['add', 'https://a.com', '--label', 'L', '--by', 'x']), { cmd: 'add', arg: 'https://a.com', label: 'L', by: 'x', json: false })
  assert.throws(() => parseArgs(['add', 'u', '--nope']), /unknown option/)
  assert.throws(() => parseArgs(['add', '--label']), /needs a value/)
})

test('CLI add / list / remove with --by', async () => {
  const home = await tmp()
  let r = await cli(home, ['add', 'https://dagster.example.com/runs/1', '--label', 'Dagster run', '--by', A])
  assert.equal(r.code, 0)
  assert.match(r.out[0], /linked Dagster run/)
  r = await cli(home, ['list', '--by', A])
  assert.deepEqual(r.out, ['1. Dagster run — https://dagster.example.com/runs/1'])
  r = await cli(home, ['list', '--by', A, '--json'])
  assert.deepEqual(JSON.parse(r.out[0]), { sessionId: A, links: [{ url: 'https://dagster.example.com/runs/1', label: 'Dagster run' }] })
  r = await cli(home, ['remove', '1', '--by', A])
  assert.equal(r.code, 0)
  assert.deepEqual((await cli(home, ['list', '--by', A])).out, ['no links'])
  assert.equal((await cli(home, ['remove', '1', '--by', A])).code, 1)
})

test('CLI defaults to CLAUDE_CODE_SESSION_ID and otherwise requires --by', async () => {
  const home = await tmp()
  assert.equal((await cli(home, ['add', 'https://a.example.com/'], { env: { CLAUDE_CODE_SESSION_ID: A } })).code, 0)
  assert.equal((await readLinks(home, A)).length, 1)
  const r = await cli(home, ['add', 'https://a.example.com/'])
  assert.equal(r.code, 1)
  assert.match(r.err[0], /pass --by/)
})

test('CLI accepts the app local_ id via the records', async () => {
  const home = await tmp()
  const records = [{ sessionId: `local_${A}`, cliSessionId: A, title: 'T', cwd: '/x' }]
  const r = await cli(home, ['add', 'https://a.example.com/', '--by', `local_${A}`], { deps: { records } })
  assert.equal(r.code, 0)
  assert.equal((await readLinks(home, A)).length, 1)
  assert.equal((await cli(home, ['add', 'https://a.example.com/', '--by', `local_${id(9)}`], { deps: { records } })).code, 1)
})

test('CLI refuses unsafe URLs, unknown commands and missing arguments with exit 1', async () => {
  const home = await tmp()
  for (const argv of [['add', 'javascript:alert(1)', '--by', A], ['add', 'https://u:p@a.com/', '--by', A], ['add', '--by', A], ['frob', '--by', A], [], ['add', 'https://a.com', '--by', 'bad id']]) {
    const r = await cli(home, argv)
    assert.equal(r.code, 1, JSON.stringify(argv))
  }
  assert.deepEqual(await readAllLinks(home), {})
})

// --- the join: roster lookup carries links ---
test('buildLookup and roster --json carry each session\'s links', async () => {
  const NOW = 1_800_000_000_000
  const rec = (n) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `T${n}`, cwd: `/w/${n}`, branch: 'b', lastActivityAt: NOW - 1000 })
  const links = { [id(1)]: [{ url: 'https://a.example.com/', label: 'A' }] }
  const world = { records: [rec(1), rec(2)], state: { overlays: {}, roles: {}, parked: {}, done: {} }, roles: {}, markers: [], working: [], tasks: {}, links, now: NOW, branchOf: async () => '' }
  const list = await buildLookup({ ...world, all: true })
  assert.deepEqual(list.find((e) => e.sessionId === id(1)).links, links[id(1)])
  assert.deepEqual(list.find((e) => e.sessionId === id(2)).links, [])
  const out = []
  assert.equal(await runRoster(['get', id(1), '--json'], { deps: world, now: NOW, log: (l) => out.push(l) }), 0)
  assert.deepEqual(JSON.parse(out[0]).links, links[id(1)])
  const text = []
  await runRoster(['get', id(1)], { deps: world, now: NOW, log: (l) => text.push(l) })
  assert.match(text[0], /link A — https:\/\/a\.example\.com\//)
})

// --- the hook's SessionEnd and the server ---
import { spawn, spawnSync } from 'node:child_process'
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..')

test('SessionEnd removes the session\'s links; park does not touch them', async () => {
  const home = await tmp()
  await addLink(home, A, 'https://a.example.com/')
  const hook = (mode, event) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'zarvis-hook.mjs'), mode], { input: JSON.stringify({ session_id: A, hook_event_name: event, cwd: '/x' }), env: { ...process.env, ZARVIS_HOME: home }, timeout: 8000 })
  hook('idle', 'Stop')
  assert.equal((await readLinks(home, A)).length, 1)
  hook('done', 'SessionEnd')
  assert.deepEqual(await readLinks(home, A), [])
})

test('server: queue rows and tree nodes carry validated links; a hostile file contributes nothing', async () => {
  const home = await tmp()
  const desktop = await tmp()
  const org = path.join(desktop, 'acct', 'org')
  await fsp.mkdir(org, { recursive: true })
  await fsp.mkdir(path.join(home, 'working'), { recursive: true })
  await fsp.writeFile(path.join(org, `local_${A}.json`), JSON.stringify({ sessionId: `local_${A}`, cliSessionId: A, title: 'ETL worker', cwd: '/w/etl', lastActivityAt: Date.now() }))
  await fsp.writeFile(path.join(home, 'working', `${A}.json`), JSON.stringify({ sessionId: A, state: 'working', at: Date.now(), seen: Date.now(), cwd: '/w/etl' }))
  await addLink(home, A, 'https://dagster.example.com/runs/1', 'Dagster run')
  const file = linksFile(home, A)
  const o = JSON.parse(await fsp.readFile(file, 'utf8'))
  o.links.push({ url: 'javascript:alert(1)', label: 'evil' }, { url: 'https://u:p@evil.example/', label: 'cred' })
  await fsp.writeFile(file, JSON.stringify(o))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, ZARVIS_HOME: home, ZARVIS_PORT: String(port), ZARVIS_DESKTOP_SESSIONS: desktop, ZARVIS_DRY_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((res, rej) => { p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res()); p.on('exit', () => rej(new Error('server exited'))) })
    const want = [{ url: 'https://dagster.example.com/runs/1', label: 'Dagster run' }]
    const q = await (await fetch(`http://127.0.0.1:${port}/api/queue`)).json()
    assert.deepEqual(q.queue.find((r) => r.sessionId === A).links, want)
    const t = await (await fetch(`http://127.0.0.1:${port}/api/tree`)).json()
    const nodes = [...t.interface, ...t.unclassified, ...t.orphans, ...t.managers]
    assert.deepEqual(nodes.find((n) => n.sessionId === A).links, want)
  } finally {
    p.kill()
  }
})

// --- file links ---
import { fileUrlOf, openPlan, isFileUrl } from '../lib/links.mjs'

test('file: URLs are accepted only as file:///absolute/path with no host, credentials, query or encoded slashes', () => {
  assert.equal(cleanUrl('file:///Users/me/report.html'), 'file:///Users/me/report.html')
  for (const bad of ['file://host/etc/passwd', 'file://user@/x', 'file:///', 'file:///a?b=1', 'file:///a#x', 'file:///a%2Fb', 'file:///a%00b', 'file:///a b']) assert.equal(cleanUrl(bad), '', bad)
})

test('fileUrlOf turns typed paths into file URLs and leaves URLs alone', () => {
  assert.equal(fileUrlOf('/tmp/a b.html'), 'file:///tmp/a%20b.html')
  assert.equal(fileUrlOf('~/out.pdf', '/x', '/home/u'), 'file:///home/u/out.pdf')
  assert.equal(fileUrlOf('./r.html', '/work'), 'file:///work/r.html')
  assert.equal(fileUrlOf('https://a.com/'), null)
  assert.equal(fileUrlOf('javascript:1'), null)
})

test('openPlan opens plain documents and only reveals anything that could execute', () => {
  assert.deepEqual(openPlan('file:///t/r.HTML'), { path: '/t/r.HTML', mode: 'open' })
  for (const f of ['x.command', 'x.app', 'x.sh', 'x.pkg', 'noext']) assert.equal(openPlan(`file:///t/${f}`).mode, 'reveal', f)
  assert.equal(openPlan('https://a.com/'), null)
  assert.equal(isFileUrl('file:///x'), true)
})

test('CLI add takes a file path; the label defaults to the file name', async () => {
  const home = await tmp()
  const r = await cli(home, ['add', './out/report.html', '--by', A], { cwd: '/work/proj' })
  assert.equal(r.code, 0)
  assert.deepEqual(await readLinks(home, A), [{ url: 'file:///work/proj/out/report.html', label: 'report.html' }])
  assert.equal((await cli(home, ['remove', '/work/proj/out/report.html', '--by', A], { cwd: '/' })).code, 0)
})

test('server: /api/open-link only acts on a file link that session posted', async () => {
  const home = await tmp()
  const file = path.join(home, 'r.html')
  await fsp.writeFile(file, '<p>x</p>')
  const url = fileUrlOf(file)
  await addLink(home, A, url, 'Report')
  await addLink(home, A, 'https://a.example.com/')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, ZARVIS_HOME: home, ZARVIS_PORT: String(port), ZARVIS_DESKTOP_SESSIONS: await tmp(), ZARVIS_DRY_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((res, rej) => { p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res()); p.on('exit', () => rej(new Error('server exited'))) })
    const base = `http://127.0.0.1:${port}`
    const post = (body) => fetch(`${base}/api/open-link`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))
    assert.deepEqual(await post({ sessionId: A, url }), { status: 200, body: { ok: true, mode: 'open', dryRun: true } })
    assert.equal((await post({ sessionId: A, url, reveal: true })).body.mode, 'reveal')
    assert.equal((await post({ sessionId: A, url: 'file:///etc/passwd' })).status, 404) // never posted
    assert.equal((await post({ sessionId: id(2), url })).status, 404) // another session's
    assert.equal((await post({ sessionId: A, url: 'https://a.example.com/' })).status, 404) // not a file link
    await fsp.rm(file)
    assert.equal((await post({ sessionId: A, url })).status, 404) // gone
  } finally {
    p.kill()
  }
})

import { modeFor } from '../lib/links.mjs'
test('modeFor judges the real target: a document name that points at a script is only revealed', () => {
  assert.equal(modeFor('/t/report.html'), 'open')
  assert.equal(modeFor('/t/evil.command'), 'reveal')
  assert.equal(modeFor('/t/dir'), 'reveal')
})
