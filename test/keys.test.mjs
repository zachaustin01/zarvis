import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'

/** The key sheet's markup. */
const sheet = (html) => html.slice(html.indexOf('id="ovHelp"'), html.indexOf('id="ovPick"'))
const read = (f) => fsp.readFile(new URL(`../${f}`, import.meta.url), 'utf8')

test('park keys: plain p opens the Parked view, Shift+P parks, in the code and in every place that names them', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  assert.match(app, /e\.key === 'P' && items\(\)\.length\) \{ e\.preventDefault\(\); parkSel\(\)/)
  assert.match(app, /e\.key === 'p'\) setView\('parked'\)/)
  assert.match(sheet(html), /<kbd>P<\/kbd>[^]*?Park/)
  assert.match(sheet(html), /<kbd>p<\/kbd><\/span><span class="kd">Parked view/)
  assert.match(readme, /`P` park \(Shift\+P\)/)
  assert.match(readme, /`p` parked view/)
  assert.doesNotMatch(app + html + readme, /p to unpark|`p` park |p park ·|Not parked \(p /)
})

test('role filter keys: m / w toggle the queue filter after the n / c second-key branches, and are documented', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  const at = (s) => app.indexOf(s)
  assert.ok(at("if (awaitingNew)") < at("e.key === 'm' || e.key === 'w'") && at("if (awaitingRole)") < at("e.key === 'm' || e.key === 'w'"))
  assert.match(sheet(html), /<kbd>m<\/kbd> <kbd>w<\/kbd><\/span><span class="kd">Queue role filter/)
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
  assert.match(sheet(html), /<kbd>v<\/kbd><\/span><span class="kd">Roles: show or hide parked/)
  assert.match(readme, /`v` show\/hide parked sessions on the Roles page/)
})

test('Tab cycles the views but leaves inputs and the key sheet alone, and is documented', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  assert.match(app, /e\.key !== 'Tab'/)
  // Window capture phase, so no pending second key or dialog handler can swallow Tab and let the browser move focus.
  assert.match(app, /window\.addEventListener\('keydown', \(e\) => \{\n  if \(e\.key !== 'Tab'[\s\S]*?\}, true\)/)
  assert.match(app, /closest\?\.\('input,textarea,select,\[contenteditable\]'\) \|\| pick \|\| parking \|\| \$\('#ovHelp'\)\.classList\.contains\('on'\)\) return\n\s+e\.preventDefault\(\)/) // bails before preventDefault
  assert.match(app, /nextView\(view, e\.shiftKey \? -1 : 1\)/)
  assert.match(sheet(html), /<kbd>Tab<\/kbd><\/span><span class="kd">Cycle Queue, Roles, Parked/)
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
  assert.match(app, /const att = attention\(queue, now, OVERDUE_MS\)\n\s+updateTab\(att\)/)
  assert.match(app, /if \(fav\.key === faviconKey\) return/)
})

test('event ticker: diffed per push, collapsible with e, remembered, documented', async () => {
  const [app, html, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('README.md')])
  assert.match(app, /pushEvents\(queue\)/)
  assert.match(app, /e\.key === 'e'/)
  assert.match(app, /localStorage\.setItem\('zarvis\.ticker'/)
  assert.match(html, /id="tk"/)
  assert.match(sheet(html), /<kbd>e<\/kbd><\/span><span class="kd">Event ticker/)
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

test('the interface keeps a queue row when not running: wired in the server, dimmed in the UI', async () => {
  const [server, lookup, app] = await Promise.all([read('server.mjs'), read('lib/lookup.mjs'), read('public/app.js')])
  assert.match(lookup, /pinnedRows\(nodes, records, built/)
  assert.match(server, /collectRows\(/)
  assert.doesNotMatch(server, /if \(!markers\.length && !working\.length\) return \[\]/) // no early return that drops it
  assert.match(app, /r\.state === 'unknown' \? ' ns' : ''/)
})

test('arc reactor: markup in the header, driven from updateAmbient, motion off for reduced-motion, text hidden when narrow', async () => {
  const [app, html, css] = await Promise.all([read('public/app.js'), read('public/index.html'), read('public/app.css')])
  assert.match(html, /id="reactor"/)
  assert.equal((html.match(/class="rx-arc /g) || []).length, 4)
  assert.match(app, /updateReactor\(att\)/)
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.reactor \.rx-ring,\.reactor \.rx-core\{animation:none/)
  assert.match(css, /max-width:900px\)\{\.rx-txt\{display:none/)
})

test('HUD extras: reactor ticks and glow, two header dials, and the project rail with its b key', async () => {
  const [app, html, css, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('public/app.css'), read('README.md')])
  assert.match(html, /class="rx-ticks"/)
  assert.match(html, /class="rx-glow"/)
  assert.match(html, /id="dialWait"/)
  assert.match(html, /id="dialHook"/)
  assert.match(html, /<aside id="rail"/)
  assert.match(app, /updateDials\(now\)/)
  assert.match(app, /e\.key === 'b'/)
  assert.match(app, /localStorage\.setItem\('zarvis\.rail'/)
  assert.match(css, /@media \(min-width:1100px\)\{\s*body\.rail-on\{padding-left:176px\}/) // the rail only exists on wide windows
  assert.match(css, /max-width:900px\)\{\.dials\{display:none/)
  assert.match(css, /reactor \.rx-glow\{animation:none/)
  assert.match(sheet(html), /<kbd>b<\/kbd><\/span><span class="kd">Project rail/)
  assert.match(readme, /`b` show\/hide the project rail/)
})

test('the interface panel draws each interface session inside a big ring, with a time-driven spin and no motion for reduced-motion', async () => {
  const [app, css] = await Promise.all([read('public/app.js'), read('public/app.css')])
  assert.match(app, /iface\.map\(\(r\) => ringHtml\(r, now\)\)/)
  assert.match(app, /animation-delay:\$\{loopDelay\(now, g\.state === 'working' \? 12000 : 30000\)\}/) // continuous across the redraw on every push
  assert.match(css, /\.ifr-ticks\{animation:ifrburst 30s/)
  assert.match(css, /\.ifr-working \.ifr-ticks\{animation-duration:12s/)
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.ifr-ticks\{animation:none/)
})

test('the key hints live only in the ? sheet: no always-on hint line, every key has a row, sections are grouped', async () => {
  const html = await read('public/index.html')
  assert.doesNotMatch(html.slice(0, html.indexOf('id="ovHelp"')), /class="hint"/) // nothing under the list
  const sh = sheet(html)
  for (const k of ['j', 'k', 'Enter', 'i', 'n', 'r', 'Tab', 'h', 'q', 't', 'p', '/', 'g', 'G', 'm', 'w', 'v', 'P', 'u', 'd', 'z', 'c', 'a', 'b', 'e', '?']) {
    assert.ok(sh.includes(`<kbd>${k}</kbd>`), `the sheet lists ${k}`)
  }
  for (const h of ['Move &amp; open', 'Views', 'Filters', 'Sessions', 'Screen']) assert.ok(sh.includes(`<h3>${h}</h3>`), h)
})
