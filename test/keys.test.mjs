import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'

const read = (f) => fsp.readFile(new URL(`../${f}`, import.meta.url), 'utf8')

test('park keys: plain p opens the Parked view, Shift+P parks, in the code and in every place that names them', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  assert.match(app, /e\.key === 'P' && items\(\)\.length\) \{ e\.preventDefault\(\); parkSel\(\)/)
  assert.match(app, /e\.key === 'p'\) setView\('parked'\)/)
  assert.match(html, /P park ·.*p parked ·/)
  assert.match(html, /<b>P<\/b><span>Park the selection/)
  assert.match(html, /<b>p<\/b><span>Parked view/)
  assert.match(readme, /`P` park \(Shift\+P\)/)
  assert.match(readme, /`p` parked view/)
  assert.doesNotMatch(app + html + readme, /p to unpark|`p` park |p park ·|Not parked \(p /)
})

test('role filter keys: m / w toggle the queue filter after the n / c second-key branches, and are documented', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  const at = (s) => app.indexOf(s)
  assert.ok(at("if (awaitingNew)") < at("e.key === 'm' || e.key === 'w'") && at("if (awaitingRole)") < at("e.key === 'm' || e.key === 'w'"))
  assert.match(html, /<b>m w<\/b>/)
  assert.match(html, /m\/w role filter/)
  assert.match(readme, /`m`\/`w` queue role filter/)
})
