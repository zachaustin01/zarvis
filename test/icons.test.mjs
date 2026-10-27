import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const read = (f) => fs.readFileSync(path.join(pub, f))
const pngSize = (f) => ({ w: read(f).readUInt32BE(16), h: read(f).readUInt32BE(20) })

test('web app manifest points at icons that exist, at their stated sizes', () => {
  const m = JSON.parse(read('manifest.webmanifest'))
  assert.equal(m.display, 'standalone')
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'))
  for (const i of m.icons) {
    const { w, h } = pngSize(i.src.slice(1))
    assert.equal(`${w}x${h}`, i.sizes, i.src)
  }
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'))
})

test('index links the icon, the touch icon and the manifest, and the server can serve their types', () => {
  const html = read('index.html').toString()
  for (const href of ['/icon.svg', '/apple-touch-icon.png', '/manifest.webmanifest']) assert.ok(html.includes(`href="${href}"`), href)
  assert.deepEqual(pngSize('apple-touch-icon.png'), { w: 180, h: 180 })
  const server = fs.readFileSync(path.join(pub, '..', 'server.mjs'), 'utf8')
  for (const t of ["'.svg': 'image/svg+xml'", "'.png': 'image/png'", "'.webmanifest': 'application/manifest+json'"]) assert.ok(server.includes(t), t)
})
