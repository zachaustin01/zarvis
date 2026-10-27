import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appVersion } from '../lib/version.mjs'

test('appVersion: stable while nothing changes, moves when a file is edited or added, empty for a missing dir', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ver-'))
  await fsp.writeFile(path.join(dir, 'app.js'), 'one')
  const a = await appVersion(dir)
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.equal(await appVersion(dir), a)
  await fsp.writeFile(path.join(dir, 'app.js'), 'two!') // different size
  const b = await appVersion(dir)
  assert.notEqual(b, a)
  await fsp.writeFile(path.join(dir, 'app.css'), 'x')
  assert.notEqual(await appVersion(dir), b)
  await fsp.mkdir(path.join(dir, 'sub')) // directories are ignored
  const c = await appVersion(dir)
  await fsp.rmdir(path.join(dir, 'sub'))
  assert.equal(await appVersion(dir), c)
  assert.equal(await appVersion(path.join(dir, 'nope')), '')
  await fsp.rm(dir, { recursive: true })
})
