import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { runEvent, parseArgs } from '../lib/events-cli.mjs'
import { buildEvent, appendEvent, readEvents, maybeTrim, eventsFile, autoEventsFor, logAutoEvents, autoEventsEnabled } from '../lib/events.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOOK = path.join(ROOT, 'hooks/zarvis-hook.mjs')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zarvis-ev-'))
const SID = 'abcdef12-3456-7890-abcd-ef1234567890'
const NOW = 1_800_000_000_000

async function cli(argv, opts = {}) {
  const home = opts.home || tmp()
  const out = [], errs = []
  const code = await runEvent(argv, { home, now: NOW, env: opts.env || {}, log: (l) => out.push(l), err: (l) => errs.push(l) })
  return { code, out, errs, home, lines: () => (fs.existsSync(eventsFile(home)) ? fs.readFileSync(eventsFile(home), 'utf8').split('\n').filter(Boolean) : []) }
}

test('CLI appends one JSON line with the documented fields', async () => {
  const r = await cli(['pushed PROJ-12 to branch fix-login', '--kind', 'push', '--url', 'https://github.com/a/b/pull/1', '--by', SID])
  assert.equal(r.code, 0)
  assert.deepEqual(r.lines().map((l) => JSON.parse(l)), [{ at: NOW, sessionId: SID, kind: 'push', text: 'pushed PROJ-12 to branch fix-login', url: 'https://github.com/a/b/pull/1' }])
})

test('CLI: kind defaults to info; session id from CLAUDE_CODE_SESSION_ID, else none; --by wins', async () => {
  const a = await cli(['hi'], { env: { CLAUDE_CODE_SESSION_ID: SID } })
  assert.deepEqual(JSON.parse(a.lines()[0]), { at: NOW, sessionId: SID, kind: 'info', text: 'hi' })
  const b = await cli(['hi'])
  assert.equal('sessionId' in JSON.parse(b.lines()[0]), false)
  const c = await cli(['hi', '--by', 'zzzzzzzz-other'], { env: { CLAUDE_CODE_SESSION_ID: SID } })
  assert.equal(JSON.parse(c.lines()[0]).sessionId, 'zzzzzzzz-other')
})

test('CLI: text capped at 200, control characters and newlines flattened, words joined', async () => {
  const r = await cli(['a\nb\u001b[31mc\tD', 'x'.repeat(300)])
  const ev = JSON.parse(r.lines()[0])
  assert.equal(ev.text.length, 200)
  assert.equal(r.lines().length, 1)
  assert.ok(!/[\u0000-\u001f\u007f]/.test(ev.text))
  assert.match(ev.text, /^a b \[31mc D x+/)
})

test('CLI: bad url, bad kind, empty text, unknown option, missing value all exit 1 with one line and write nothing', async () => {
  for (const argv of [['x', '--url', 'javascript:alert(1)'], ['x', '--url', 'ftp://h/x'], ['x', '--url', `https://h/${'a'.repeat(300)}`], ['x', '--kind', 'two words'], ['x', '--kind', 'k'.repeat(21)], [], ['x', '--bogus'], ['x', '--kind'], ['x', '--by', 'no']]) {
    const r = await cli(argv)
    assert.equal(r.code, 1, JSON.stringify(argv))
    assert.match(r.errs[0], /^event: /)
    assert.equal(r.lines().length, 0)
  }
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
})

test('CLI: --dry-run prints and writes nothing', async () => {
  const r = await cli(['hello', '--kind', 'done', '--dry-run'])
  assert.equal(r.code, 0)
  assert.match(r.out[0], /would log .*"kind":"done"/)
  assert.equal(r.lines().length, 0)
})

test('CLI: unwritable home exits 0 with a stderr line', async () => {
  const f = path.join(tmp(), 'file')
  fs.writeFileSync(f, '')
  const r = await cli(['hello'], { home: path.join(f, 'sub') })
  assert.equal(r.code, 0)
  assert.match(r.errs[0], /not logged/)
})

test('CLI: --auto off/on/status flips the state flag', async () => {
  const home = tmp()
  assert.equal(autoEventsEnabled(home, {}), true)
  assert.match((await cli(['--auto', 'off'], { home })).out[0], /: off/)
  assert.equal(autoEventsEnabled(home, {}), false)
  assert.match((await cli(['--auto', 'on'], { home })).out[0], /: on/)
  assert.equal(autoEventsEnabled(home, {}), true)
  assert.equal((await cli(['--auto', 'maybe'], { home })).code, 1)
})

test('concurrent appenders: every line intact', async () => {
  const home = tmp()
  const N = 8, PER = 25
  const code = `import { buildEvent, appendEvent } from ${JSON.stringify(path.join(ROOT, 'lib/events.mjs'))}
for (let i = 0; i < ${PER}; i++) await appendEvent(process.env.ZARVIS_HOME, buildEvent({ text: process.argv[1] + ' #' + i + ' ' + 'y'.repeat(150) }, Date.now() + i))`
  const kids = Array.from({ length: N }, (_, n) => spawn(process.execPath, ['--input-type=module', '-e', code, `w${n}`], { env: { ...process.env, ZARVIS_HOME: home }, stdio: 'ignore' }))
  await Promise.all(kids.map((k) => once(k, 'exit')))
  const lines = fs.readFileSync(eventsFile(home), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, N * PER)
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l))
})

test('rotation keeps the newest 500 once past 1000 lines, and is a no-op below', async () => {
  const home = tmp()
  const file = eventsFile(home)
  const mk = (n) => JSON.stringify({ at: 1000 + n, kind: 'info', text: `e${n} ${'p'.repeat(100)}` })
  fs.writeFileSync(file, Array.from({ length: 1001 }, (_, i) => mk(i)).join('\n') + '\n')
  assert.equal(await maybeTrim(file, { checkBytes: 0 }), true)
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 500)
  assert.match(lines[0], /e501 /)
  assert.match(lines.at(-1), /e1000 /)
  assert.equal(await maybeTrim(file, { checkBytes: 0 }), false)
  assert.deepEqual(fs.readdirSync(home), ['events.jsonl'], 'no rotated leftovers')
})

test('readEvents ignores malformed lines, dedupes, sorts, caps and re-validates fields', () => {
  const home = tmp()
  fs.writeFileSync(eventsFile(home), [
    'not json', '{"at":5,"kind":"info","text":"b"}', '{"at":5,"kind":"info","text":"b"}', '{"at":2,"kind":"push","text":"a","url":"javascript:1"}',
    '{"at":"x","text":"no"}', '[]', '{"at":9,"text":"  "}', '{"at":7,"kind":"Bad Kind!","text":"c","sessionId":"../x"}', '{"at":8,"kind":"warn","text":"d\\nd","url":"https://ok.example/x"}', '{"at":3,"kind":"i',
  ].join('\n'))
  const ev = readEvents(home, 50)
  assert.deepEqual(ev.map((e) => e.text), ['a', 'b', 'c', 'd d'])
  assert.equal('url' in ev[0], false)
  assert.equal(ev[2].kind, 'info')
  assert.equal('sessionId' in ev[2], false)
  assert.equal(ev[3].url, 'https://ok.example/x')
  assert.deepEqual(readEvents(home, 2).map((e) => e.text), ['c', 'd d'])
  assert.deepEqual(readEvents(path.join(home, 'nope')), [])
})

// --- automatic events ---
const bash = (command, resp = { stdout: '', stderr: '', interrupted: false }, extra = {}) => ({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: resp, cwd: tmp(), ...extra })

test('auto events: git push forms', () => {
  assert.deepEqual(autoEventsFor(bash('git push origin fix-login')), [{ kind: 'push', text: 'pushed fix-login to origin' }])
  assert.deepEqual(autoEventsFor(bash('git push -u origin x')), [{ kind: 'push', text: 'pushed x to origin' }])
  assert.deepEqual(autoEventsFor(bash('git push origin HEAD:refs/heads/feat')), [{ kind: 'push', text: 'pushed feat to origin' }])
  assert.deepEqual(autoEventsFor(bash('git add . && git commit -m "x" && git push origin br')), [{ kind: 'push', text: 'pushed br to origin' }])
  assert.deepEqual(autoEventsFor(bash('git push --tags origin')), [{ kind: 'push', text: 'pushed tags to origin' }])
  assert.deepEqual(autoEventsFor(bash('git push', { stdout: '', stderr: 'To github.com:a/b.git\n   abc1234..def5678  topic -> topic\n' })), [{ kind: 'push', text: 'pushed topic' }])
})

test('auto events: branch comes from .git/HEAD when the command does not say', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/my-branch\n')
  assert.deepEqual(autoEventsFor(bash('git push origin', undefined, { cwd: root })), [{ kind: 'push', text: 'pushed my-branch to origin' }])
})

test('auto events: failures, dry runs, up-to-date and non-Bash tools make none', () => {
  assert.deepEqual(autoEventsFor(bash('git push origin x', { stderr: 'error: failed to push some refs to x', stdout: '' })), [])
  assert.deepEqual(autoEventsFor(bash('git push origin x', { stderr: ' ! [rejected]  x -> x (non-fast-forward)' })), [])
  assert.deepEqual(autoEventsFor(bash('git push origin x', { exitCode: 1 })), [])
  assert.deepEqual(autoEventsFor(bash('git push origin x', { interrupted: true })), [])
  assert.deepEqual(autoEventsFor(bash('git push --dry-run origin x')), [])
  assert.deepEqual(autoEventsFor(bash('git push', { stderr: 'Everything up-to-date' })), [])
  assert.deepEqual(autoEventsFor(bash('git status && echo push')), [])
  assert.deepEqual(autoEventsFor({ ...bash('git push origin x'), tool_name: 'Write' }), [])
})

test('auto events: gh pr create extracts the URL', () => {
  const out = 'Creating pull request for x into main in a/b\n\nhttps://github.com/a/b/pull/42\n'
  assert.deepEqual(autoEventsFor(bash('gh pr create --title "t" --body b', { stdout: out })), [{ kind: 'pr', text: 'opened a PR', url: 'https://github.com/a/b/pull/42' }])
  assert.deepEqual(autoEventsFor(bash('gh pr create', { stdout: '' })), [{ kind: 'pr', text: 'opened a PR' }])
  assert.deepEqual(autoEventsFor(bash('gh pr view 3')), [])
})

test('auto events: opt-out via env and via state', async () => {
  const home = tmp()
  assert.equal((await logAutoEvents(bash('git push origin x'), home, NOW, { ZARVIS_AUTO_EVENTS: '0' })).length, 0)
  assert.equal(readEvents(home).length, 0)
  fs.writeFileSync(path.join(home, 'state.json'), '{"autoEvents":false}')
  assert.equal((await logAutoEvents(bash('git push origin x'), home, NOW, {})).length, 0)
  fs.writeFileSync(path.join(home, 'state.json'), '{}')
  assert.equal((await logAutoEvents(bash('git push origin x'), home, NOW, {})).length, 1)
  assert.equal(readEvents(home)[0].sessionId, SID)
})

test('the real hook (work mode) logs a push event, and nothing with the env opt-out', () => {
  const run = (env) => {
    const home = tmp()
    const r = spawnSync(process.execPath, [HOOK, 'work'], { input: JSON.stringify(bash('git add . && git push -u origin feat', { stdout: '', stderr: 'branch feat set up' })), env: { ...process.env, ...env, ZARVIS_HOME: home }, encoding: 'utf8', timeout: 8000 })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    return readEvents(home)
  }
  const ev = run({ ZARVIS_AUTO_EVENTS: '' })
  assert.equal(ev.length, 1)
  assert.equal(ev[0].text, 'pushed feat to origin')
  assert.equal(run({ ZARVIS_AUTO_EVENTS: '0' }).length, 0)
})

// --- the server ---
async function withServer(fn) {
  const home = tmp()
  const desktop = tmp()
  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, ZARVIS_HOME: home, ZARVIS_PORT: String(port), ZARVIS_DESKTOP_SESSIONS: desktop, ZARVIS_DRY_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((res, rej) => { p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res()); p.on('exit', () => rej(new Error('server exited'))) })
    await fn({ home, base: `http://127.0.0.1:${port}` })
  } finally {
    p.kill()
  }
}

test('server: GET /api/events (JSON) and the live payload carry pushed events; the stream still works', async () => {
  await withServer(async ({ home, base }) => {
    await appendEvent(home, buildEvent({ text: '<img src=x onerror=alert(1)>', kind: 'warn', url: 'https://a.example/x', sessionId: SID }, NOW))
    fs.appendFileSync(eventsFile(home), 'garbage\n')
    const j = await (await fetch(`${base}/api/events`)).json()
    assert.equal(j.events.length, 1)
    assert.equal(j.events[0].text, '<img src=x onerror=alert(1)>') // raw data; the browser escapes it
    const q = await (await fetch(`${base}/api/queue`)).json()
    assert.equal(q.events.length, 1)
    const res = await fetch(`${base}/api/events`, { headers: { accept: 'text/event-stream' } })
    assert.match(res.headers.get('content-type'), /event-stream/)
    const reader = res.body.getReader()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    assert.match(chunk, /"events":\[\{/)
    await reader.cancel()
  })
})
