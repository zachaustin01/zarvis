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

test('both list renders keep a half-typed rename across live redraws', async () => {
  const app = await read('public/app.js')
  assert.equal((app.match(/const renameSnap = snapRename\(\)/g) || []).length, 2) // queue and role tree
  assert.equal((app.match(/restoreRename\(renameSnap\)/g) || []).length, 2)
  assert.doesNotMatch(app, /inp\.select\(\)/) // the old unconditional select() that swallowed typing
})

test('v toggles parked sessions on the Roles page: default hidden, remembered, searched sessions still show, documented', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  assert.match(app, /let showParked = false/)
  assert.match(app, /localStorage\.setItem\('zarvis\.showParked'/)
  assert.match(app, /view === 'tree' && !showParked && !filter\.trim\(\)/) // a search shows parked too
  assert.match(app, /parkedList = \[\.\.\.flatten\(full\)/) // the Parked view never loses them
  assert.match(app, /e\.key === 'v'/)
  assert.match(html, /<b>v<\/b>/)
  assert.match(html, /v parked in roles/)
  assert.match(readme, /`v` show\/hide parked sessions on the Roles page/)
})

test('Tab cycles the views but leaves inputs and the key sheet alone, and is documented', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  assert.match(app, /e\.key !== 'Tab'/)
  // Window capture phase, so no pending second key or dialog handler can swallow Tab and let the browser move focus.
  assert.match(app, /window\.addEventListener\('keydown', \(e\) => \{\n  if \(e\.key !== 'Tab'[\s\S]*?\}, true\)/)
  assert.match(app, /closest\?\.\('input,textarea,select,\[contenteditable\]'\) \|\| pick \|\| parking \|\| \$\('#ovHelp'\)\.classList\.contains\('on'\)\) return\n\s+e\.preventDefault\(\)/) // bails before preventDefault
  assert.match(app, /nextView\(view, e\.shiftKey \? -1 : 1\)/)
  assert.match(html, /<b>Tab<\/b>/)
  assert.match(html, /Tab views/)
  assert.match(readme, /`Tab`\/`Shift\+Tab` cycle Queue/)
})

test('HUD effects: fuse, glow, brackets and arrival sweep are wired and honour reduced motion', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/app.css')])
  assert.match(app, /fuseHtml\(r, now\)/)
  assert.match(app, /updateAmbient\(now\)/) // re-evaluated every second, so overdue turns the glow red
  assert.match(css, /\.q\.sel::after/)
  assert.match(css, /body\.has-od/)
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*\.fuse/)
  assert.match(css, /tab-hidden/)
})

test('tab title and favicon are driven from updateAmbient and redrawn only when the state flips', async () => {
  const app = await read('public/app.js')
  assert.match(app, /updateTab\(attention\(queue, now, OVERDUE_MS\)\)/)
  assert.match(app, /if \(fav\.key === faviconKey\) return/)
})

test('event ticker: diffed per push, collapsible with e, remembered, documented', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  assert.match(app, /pushEvents\(queue\)/)
  assert.match(app, /e\.key === 'e'/)
  assert.match(app, /localStorage\.setItem\('zarvis\.ticker'/)
  assert.match(html, /id="tk"/)
  assert.match(html, /<b>e<\/b>/)
  assert.match(html, /e ticker/)
  assert.match(readme, /`e` collapse\/expand the event ticker/)
})

test('the Parked view includes archived parked sessions, dimmed and tagged, and only there', async () => {
  const app = await read('public/app.js')
  assert.match(app, /parkedList = \[\.\.\.flatten\(full\), \.\.\.\(full\.archived \|\| \[\]\)\]/)
  assert.match(app, /r\.archived \? ' arch' : ''/)
  assert.match(app, /<span class="ap">archived<\/span>/)
  assert.doesNotMatch(app, /flatten = .*archived/) // the Roles tree and the chip set never see them
})

test('ticker scroll: planned from the pure helper, pauses on hover/focus/hidden, new events snap to the newest, collapsed state replans', async () => {
  const app = await read('public/app.js')
  assert.match(app, /scrollPlan\(\{ count: tickerItems\.length/)
  assert.match(app, /TICKER_PAUSE_MS/)
  for (const r of ['hover', 'focus', 'hidden']) assert.match(app, new RegExp(`hold\\('${r}'`))
  assert.match(app, /planScroll\(r\.added\.length > 0 && !seed\)/)
  assert.match(app, /paintTickerState\(\)\n\s+planScroll\(\)/) // expanding or collapsing replans
  assert.doesNotMatch(app, /\.innerHTML = .*tk/) // entries are built with textContent
})
