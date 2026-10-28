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
  assert.match(app, /e\.key === 'E'\) \{ e\.preventDefault\(\); setList\(!listOpen\) \}/) // Shift+E toggles the list, strip collapsed or not
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

test('ticker: static latest event, a list that opens from the label with an unread count, slide only for a batch, no marquee', async () => {
  const [app, html, css] = await Promise.all([read('public/app.js'), read('public/index.html'), read('public/app.css')])
  assert.match(html, /id="tkN"/)
  assert.match(html, /id="tkPanel"/)
  assert.match(app, /\$\('#tkLbl'\)\.addEventListener\('click', \(\) => setList\(!listOpen\)\)/)
  assert.match(app, /tickerUnread = listOpen \? 0 : tickerUnread \+ r\.added\.length/)
  assert.match(app, /groupByDay\(/)
  assert.match(app, /setTimeout\(show, i \* TICKER_SLIDE_MS\)/)
  assert.doesNotMatch(app, /\.animate\(|scrollPlan|tkTrack/) // no marquee
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.tk \.ev\.new\{animation:none\}/)
  assert.doesNotMatch(app, /\.innerHTML = .*tk/) // entries are built with textContent
})

test('the interface keeps a queue row when it has no signal: wired in the server, dimmed in the UI', async () => {
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
  for (const k of ['j', 'k', 'Enter', 'i', 'n', 'r', 'Tab', 'h', 'q', 't', 'p', '/', 'g', 'G', 'm', 'w', 'v', 'P', 'u', 'd', 'z', 'c', 'a', 'b', 'e', 'E', '?']) {
    assert.ok(sh.includes(`<kbd>${k}</kbd>`), `the sheet lists ${k}`)
  }
  for (const h of ['Move &amp; open', 'Views', 'Filters', 'Sessions', 'Screen']) assert.ok(sh.includes(`<h3>${h}</h3>`), h)
})

test('wording: no signal is "no signal", never "not running"; the ticker line describes the real strip', async () => {
  const [html, fx, app] = await Promise.all([read('public/index.html'), read('public/fx.js'), read('public/app.js')])
  assert.match(fx, /label: 'no signal'/)
  assert.match(app, /unknown: 'No signal'/)
  assert.doesNotMatch(fx + app, /not running/i)
  const e = html.match(/<kbd>e<\/kbd><\/span><span class="kd">([^<]*)<\/span>/)[1]
  assert.match(e, /newest event/)
  assert.doesNotMatch(e, /scrolls/)
})

test('JARVIS skin: backdrop, boot-up, telemetry and flicker exist, move only outside the list, and honour reduced motion', async () => {
  const [html, css, app] = await Promise.all([read('public/index.html'), read('public/app.css'), read('public/app.js')])
  assert.match(html, /<body class="booting">/)
  assert.match(html, /id="hudbg"/)
  assert.match(html, /id="sparkLine"/)
  assert.match(html, /id="clock"/)
  assert.match(app, /updateTelemetry\(now\)/)
  assert.match(app, /classList\.remove\('booting'\)/)
  assert.match(app, /function flicker\(el\)/)
  assert.match(css, /#hudbg::after\{[^}]*animation:hudspin 300s/)
  assert.match(css, /prefers-reduced-motion:reduce\)\{\s*#hudbg::after,\.top::after,\.rx-ticks\{animation:none!important\}/)
  assert.match(css, /body\.tab-hidden #hudbg::after/)
  assert.doesNotMatch(css.slice(css.indexOf('JARVIS skin')), /backdrop-filter/) // too costly with a long list
  assert.match(css, /@media \(max-width:900px\)\{\.telem\{display:none/)
})

test('text colours stay WCAG AA (4.5:1) against the panel background', async () => {
  const css = await read('public/app.css')
  const v = (n) => css.match(new RegExp(`--${n}:(#[0-9a-f]{6})`))[1]
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  for (const name of ['t1', 't2', 't3', 'cy', 'am', 'rd', 'gr']) assert.ok(ratio(v(name), '#08101a') >= 4.5, `--${name} on the panel`)
})

test('context gauge: attached server-side (path never sent), shown on rows, tree rows and the interface ring, documented', async () => {
  const [app, server, queue, readme, css] = await Promise.all([read('public/app.js'), read('server.mjs'), read('lib/queue.mjs'), read('README.md'), read('public/app.css')])
  assert.match(server, /contextOf\(file, win\)/)
  assert.match(server, /rows\.map\(async \(\{ transcript, \.\.\.r \}\)/) // the transcript path is dropped from the row
  assert.match(server, /ctx: row\?\.ctx \?\? null/)
  assert.match(queue, /transcript: m\.transcriptPath/)
  assert.equal((app.match(/\$\{ctxHtml\(r\)\}/g) || []).length, 2) // queue row and tree row
  assert.match(app, /ifr-ctxarc/)
  assert.match(app, /Math\.min\(100, c\.pct\)/) // the bar is clamped; the number is not
  assert.match(readme, /ZARVIS_CONTEXT_WINDOW/)
  assert.match(css, /\.cx-amber \.cx-tx\{color:var\(--am\)\}\.cx-red \.cx-tx\{color:var\(--rd\)\}/)
})

test('command palette: Cmd/Ctrl-K wiring, every command id has a handler that reuses the key actions, keys cannot fire under it', async () => {
  const [app, html, css, readme, pal] = await Promise.all([read('public/app.js'), read('public/index.html'), read('public/app.css'), read('README.md'), read('public/palette.js')])
  // The key handler and the palette call the same functions.
  for (const fn of ['toggleParkedShown', 'toggleRoleKey', 'stepProject', 'startRename', 'toggleHelp']) {
    assert.ok((app.match(new RegExp(`\\b${fn}\\b`, 'g')) || []).length >= 3, `${fn} is defined and used by both the key and the palette`)
  }
  assert.match(app, /e\.key === 'P' && items\(\)\.length\) \{ e\.preventDefault\(\); parkSel\(\)/) // unchanged
  const ids = [...pal.matchAll(/\{ id: '([a-z-]+)', group/g)].map((m) => m[1])
  assert.ok(ids.length > 25)
  for (const fn of ['startClassify', 'startNew']) assert.match(app, new RegExp(`\\b${fn}\\(\\) \\}`)) // the c / n keys go through them
  for (const id of ids) assert.match(app, new RegExp(`(^|\\n)\\s*(${id}|'${id}'): `), `RUN handler for ${id}`)
  // Global single keys are off while it is open; it never opens from the rename box or over a dialog.
  assert.match(app, /document\.addEventListener\('keydown', \(e\) => \{\n  if \(pick \|\| parking \|\| palette\) return/)
  assert.match(app, /if \(renaming \|\| pick \|\| parking\) return \/\/ never from inside the rename box/)
  assert.match(app, /\(e\.metaKey \|\| e\.ctrlKey\)/)
  assert.match(app, /e\.ctrlKey && \(e\.key === 'n'/)
  assert.match(app, /back\.focus\(\)/) // focus restored
  assert.match(app, /if \(!force && sig === palette\.sig\) return/) // live pushes leave an unchanged list alone
  assert.match(app, /closePalette\(\)\n\s+if \(e\.type === 'session'\) return jumpToSession/)
  assert.match(html, /id="ovPal"/)
  assert.match(sheet(html), /<kbd>⌘K<\/kbd>/)
  assert.match(readme, /`Cmd\/Ctrl\+K` command palette/)
  const skin = css.slice(css.indexOf('Command palette (Cmd/Ctrl-K)'))
  assert.doesNotMatch(skin, /animation:/) // transitions only, on opacity and transform
  assert.match(skin, /transition:opacity/)
  assert.match(skin, /prefers-reduced-motion:reduce\)\{\.ov\.pal/)
  assert.match(skin, /body\.tab-hidden \.ov\.pal/)
  assert.doesNotMatch(app.slice(app.indexOf('function renderPalette')), /#list'\)\.innerHTML/)
})

test('pagination: nothing scrolls, lists page by measured height, page keys do not take Tab, the pager flags urgent rows elsewhere', async () => {
  const [app, html, css, readme] = await Promise.all([read('public/app.js'), read('public/index.html'), read('public/app.css'), read('README.md')])
  assert.match(css, /html,body\{height:100%;overflow:hidden\}/)
  assert.doesNotMatch(css, /overflow(-[xy])?:\s*(auto|scroll)/) // no element may scroll
  assert.doesNotMatch(css, /scrollbar-width/)
  assert.doesNotMatch(app, /scrollIntoView/) // nothing to scroll to
  for (const fn of ['renderTree', 'renderParked', 'render']) assert.match(app, new RegExp(`function ${fn}\\(\\) \\{\\n(  \\w+\\(\\)\\n)+  paginateList\\(\\)`)) // every list view is paged
  assert.match(app, /paginate\(heights, heads, avail\)/)
  assert.match(app, /e\.key === 'PageDown' \|\| e\.key === '\]'/)
  assert.match(app, /e\.key === 'PageUp' \|\| e\.key === '\['/)
  assert.match(app, /if \(changed && at >= 0\) page = pageOfIndex\(pages, at\)/) // follow a changed selection, never a live push
  assert.match(app, /flagElsewhere\(pageUrgency\(\), page\)/)
  assert.match(app, /addEventListener\('wheel'/)
  assert.match(app, /addEventListener\('touchend'/)
  assert.match(app, /windowAround\(h\.idx, entries\.length/) // the palette windows its results
  assert.match(app, /windowAround\(pick\.idx/) // so does the attach picker
  assert.match(html, /id="pager"/)
  assert.match(sheet(html), /<kbd>\]<\/kbd> <kbd>\[<\/kbd>/)
  assert.match(readme, /`\]`\/`\[`/)
  // Tab keeps switching views: the page keys are separate
  assert.match(app, /e\.key !== 'Tab'/)
})

test('update app: a banner and a dialog (palette command), version from the server, hard refresh drops caches and reloads', async () => {
  const [app, html, server, palette] = await Promise.all([read('public/app.js'), read('public/index.html'), read('server.mjs'), read('public/palette.js')])
  assert.match(html, /id="ovUpd"/)
  assert.match(html, /id="updBanner"/)
  assert.match(palette, /id: 'update'/)
  assert.match(app, /update: openUpdate/)
  assert.match(app, /noteVersion\(d\.version\)/)
  assert.match(app, /getRegistrations/)
  assert.match(app, /caches\?\.keys\?\.\(\)/)
  assert.match(app, /location\.replace\(`\$\{location\.pathname\}\?v=\$\{Date\.now\(\)\}`\)/)
  assert.match(server, /pathname === '\/api\/version'/)
  assert.match(server, /lastVersion/)
})

test('session links: chips on queue and tree cards re-check the URL, open in a new tab and never trigger the row', async () => {
  const [app, css, server, hook] = await Promise.all([read('public/app.js'), read('public/app.css'), read('server.mjs'), read('hooks/zarvis-hook.mjs')])
  assert.match(app, /safeUrl\(l\?\.url\)/) // the browser re-validates
  assert.match(app, /<a class="lk" href="\$\{esc\(l\.url\)\}" target="_blank" rel="noopener noreferrer"/)
  assert.match(app, /\$\{cmd\}|cmd \+\n    linksHtml\(r\) \+\n    bgList\(r, now\)/) // inside the measured queue row
  assert.match(app, /<\/div>\$\{linksHtml\(r\)\}\$\{bgList\(r\)\}<span class="go">/) // and the tree row
  assert.match(app, /if \(e\.target\.closest\('\.lk'\)\) \{[^]*?\n      return\n    \}\n    sel = q\.dataset\.id/) // a chip click (web or file) returns before the row selects or redraws
  assert.match(app, /class="lk lkf" data-u=/) // a file link is a button, never an href
  assert.match(app, /closest\('\.q'\) && !e\.target\.closest\('\.lk, \.lkm'\)\) openSel/) // nor a double-click open
  assert.doesNotMatch(css.slice(css.indexOf('.lks{')), /animation/) // chips never animate, so a redraw restarts nothing
  assert.match(server, /links: links\[n\.sessionId\] \|\| \[\]/)
  assert.match(server, /links: links\[r\.sessionId\] \|\| \[\]/)
  assert.match(hook, /'links', `\$\{id\}\.json`/) // SessionEnd removes them
})
