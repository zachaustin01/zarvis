import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readState, parkSession, setOverlay, setDone, withState } from '../lib/state.mjs'

const STATE_MJS = fileURLToPath(new URL('../lib/state.mjs', import.meta.url))
const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const tmp = async () => path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-lock-')), 'state.json')

function child(code, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exit ${c}: ${err}`))))
  })
}

test('parallel processes all keep their updates (no lost writes)', async () => {
  const file = await tmp()
  const code = `import { parkSession, setOverlay, setDone } from ${JSON.stringify(STATE_MJS)}
const [file, n] = process.argv.slice(1)
const sid = n.repeat(8) + '-0000-4000-8000-000000000000'
await parkSession(sid, { reason: 'par ' + n }, file)
await setOverlay(sid, 'name ' + n, file)
if (n === 'a') await setDone(sid, true, file)`
  const names = [...'abcdefghijklmn']
  await Promise.all(names.map((n) => child(code, [file, n])))
  const s = await readState(file)
  const parked = Object.keys(s.parked).sort()
  assert.deepEqual(parked, names.filter((n) => n !== 'a').map(id).sort(), 'every park survived (a was marked done)')
  assert.equal(Object.keys(s.overlays).length, names.length, 'every overlay survived')
  assert.equal(s.done[id('a')], true)
  assert.deepEqual((await fsp.readdir(path.dirname(file))).sort(), ['state.json'], 'no lock or tmp files left')
})

test('in-process concurrent writers serialise too', async () => {
  const file = await tmp()
  await Promise.all([...'abcdefgh'].map((n) => parkSession(id(n), { reason: n }, file)))
  assert.equal(Object.keys((await readState(file)).parked).length, 8)
})

test('a stale lock (old, or owned by a dead process) is recovered', async () => {
  const file = await tmp()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const old = new Date(Date.now() - 60_000)
  await fsp.writeFile(`${file}.lock`, `${process.pid}.x`)
  await fsp.utimes(`${file}.lock`, old, old)
  await parkSession(id(1), { reason: 'after stale' }, file)
  assert.ok((await readState(file)).parked[id(1)])

  await fsp.writeFile(`${file}.lock`, '2147483000.x') // fresh, but no such process
  const t = Date.now()
  await parkSession(id(2), { reason: 'after dead owner' }, file)
  assert.ok(Date.now() - t < 5000)
  assert.ok((await readState(file)).parked[id(2)])
})

test('a live holder is waited for, not broken', async () => {
  const file = await tmp()
  let release
  const held = withState(async () => { await new Promise((r) => (release = r)) }, file)
  await new Promise((r) => setTimeout(r, 50))
  let done = false
  const second = parkSession(id(1), { reason: 'x' }, file).then(() => (done = true))
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(done, false, 'blocked while the lock is held')
  release()
  await held
  await second
  assert.ok((await readState(file)).parked[id(1)])
})

test('a failing mutation writes nothing and releases the lock', async () => {
  const file = await tmp()
  await parkSession(id(1), { reason: 'keep' }, file)
  await assert.rejects(withState(() => { throw new Error('boom') }, file), /boom/)
  assert.equal((await readState(file)).parked[id(1)].reason, 'keep')
  await parkSession(id(2), { reason: 'next' }, file) // would hang if the lock leaked
})

test('a corrupt state.json is never overwritten by a writer; readers see it as empty', async () => {
  const file = await tmp()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, '{ "parked": { "half')
  await assert.rejects(parkSession(id(1), { reason: 'x' }, file), /not valid JSON/)
  await assert.rejects(setOverlay(id(1), 'n', file), /not valid JSON/)
  assert.equal(await fsp.readFile(file, 'utf8'), '{ "parked": { "half', 'file untouched')
  assert.deepEqual((await readState(file)).parked, {})
  await assert.rejects(fsp.access(`${file}.lock`), 'lock released')
})

test('a torn read that heals during the retries is not mistaken for corruption', async () => {
  const file = await tmp()
  await parkSession(id(1), { reason: 'real' }, file)
  const good = await fsp.readFile(file, 'utf8')
  await fsp.writeFile(file, '{ "parked": ')
  setTimeout(() => fsp.writeFile(file, good), 40)
  await parkSession(id(2), { reason: 'second' }, file)
  const s = await readState(file)
  assert.deepEqual(Object.keys(s.parked).sort(), [id(1), id(2)].sort())
})
