'use strict'
import { clockText, pushSample, sparkPoints, ifaceRing, loopDelay, IFACE_C, dialDash, waitDial, hookDial, projectGauges, reactorCounts, reactorArcs, reactorState, reactorText, scrollPlan, TICKER_MAX, TICKER_PAUSE_MS, fuseVars, glowState, attention, tabTitle, faviconState, snapshot, diffEvents, mergeTicker, evTime, evKindClass, safeUrl } from '/fx.js'
import { buildCommands, search as paletteSearch, keepHighlight, stepHighlight } from '/palette.js'
import { nextView, hideParked, ROLE_FILTERS, toggleRole, resolveRole, chipProjects, resolveProject, hiddenParked, ago, filterRows, hiddenBlocked, filterTreeByProject, cycleProject, projectHue } from '/projects.js'
const $ = (s) => document.querySelector(s)
const OVERDUE_MS = 5 * 60 * 1000
let queue = []
let view = 'queue' // 'queue' | 'tree' | 'parked'
let tree = { interface: [], managers: [], orphans: [], unclassified: [] }
let rawTree = null // the server's tree, done sessions included
let nodes = [] // the tree flattened in display order, for j/k
let parkedList = [] // parked sessions, newest first: the Parked view
let palette = null // the command palette while open: { q, key, idx, sig, back }
let pick = null // the attach picker: { mgr, rows, checked, idx }
let awaitingNew = false // after `n`: the next key picks the new session's role
let awaitingRole = false // after `c`: the next key picks the role
let sel = null // sessionId of the selected row
let renaming = null // sessionId being renamed
let parking = null // the park modal: { sessionId, name } while open
let undo = null // reverses the last park / unpark / done: { label, run }
let filter = '' // tree search; a non-empty one also shows done sessions
let seen = new Set()
let first = true
let fresh = new Set()
let project = '' // project filter; '' = all projects (persisted)
let showParked = false // Roles page: parked sessions hidden by default (the Parked view, p, lists them); persisted
let hiddenParkedN = 0 // how many the Roles page is hiding right now
let claims = [] // checkout claims from the server, newest write first
let roleFilter = '' // queue role filter: '' | 'manager' | 'worker' (persisted)
try { project = localStorage.getItem('zarvis.project') || '' } catch { /* storage blocked */ }
try { showParked = localStorage.getItem('zarvis.showParked') === '1' } catch { /* storage blocked */ }
try { roleFilter = resolveRole(localStorage.getItem('zarvis.role')) } catch { /* storage blocked */ }

const ICON = { interface: '◆', manager: '▣', worker: '●', unclassified: '?' }
const STATE_LABEL = { blocked: 'needs you', waiting_on_child: 'waiting on worker', working: 'working', idle: 'idle', unknown: 'no signal' }
// Project filter. A remembered project with no sessions left counts as All; the interface is never filtered out.
const projectList = () => chipProjects(queue, rawTree ? flatten(rawTree) : [])
const activeProject = () => resolveProject(project, projectList())
const visibleQueue = () => filterRows(queue, activeProject(), roleFilter)
const viewTree = () => filterTreeByProject(filterTree(rawTree, filter), activeProject())
const ifaceFirst = () => {
  const q = visibleQueue()
  return [...q.filter((r) => r.role === 'interface'), ...q.filter((r) => r.role !== 'interface')]
}
const items = () => (view === 'tree' ? nodes : view === 'parked' ? parkedList : ifaceFirst())
/** Done sessions are hidden unless searched; a search matches name, title, project, park reason and handoff note. */
function filterTree(t, q) {
  q = q.trim().toLowerCase()
  const hit = (n) => (q ? `${n.name} ${n.title} ${n.project} ${n.branch} ${n.parked?.reason || ''} ${n.parked?.handoffNote || ''} ${n.parked?.parkedByName || ''}`.toLowerCase().includes(q) : !n.done)
  const keep = (n) => hit(n) || (n.children || []).some(hit)
  return {
    interface: t.interface.filter(hit),
    managers: t.managers.filter(keep).map((m) => ({ ...m, children: m.children.filter((c) => hit(c) || hit(m)) })),
    orphans: t.orphans.filter(hit),
    unclassified: t.unclassified.filter(hit),
    archived: (t.archived || []).filter(hit), // parked sessions the app archived: only the Parked view lists them
  }
}
const flatten = (t) => [...t.interface, ...t.managers.flatMap((m) => [m, ...m.children]), ...t.orphans, ...t.unclassified]

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
}

// Managers stay in the main checkout and write no code, so their branch/worktree is never shown.
const showsWhere = (r) => r.role !== 'manager'

/** `⛓ LABEL` on the session that holds a checkout; `⛓ LABEL ⇄` on one sharing it. Dim when the claim is stale. */
function claimTag(r) {
  const held = claims.filter((c) => c.holder.sessionId === r.sessionId)
  const shared = claims.filter((c) => c.shared.some((s) => s.sessionId === r.sessionId))
  return [...held.map((c) => [c, false]), ...shared.map((c) => [c, true])]
    .map(([c, sh]) => `<span class="clm${sh ? ' sh' : ''}${c.live ? '' : ' off'}" title="${esc(sh ? `shares ${c.root} with ${c.holder.name}` : `holds ${c.root}${c.shared.length ? ` · shared with ${c.shared.map((s) => s.name).join(', ')}` : ''}${c.live ? '' : ' · stale'}`)}">⛓ ${esc(c.label)}${sh ? ' ⇄' : c.shared.length ? ' +' + c.shared.length : ''}</span>`)
    .join('')
}

/** The Roles view's Checkouts section: every claimed checkout, who holds it, who shares it. */
function claimsSection() {
  if (!claims.length) return ''
  const home = (p) => p.replace(/^\/(Users|home)\/[^/]+/, '~')
  return (
    heading('Checkouts') +
    claims
      .map(
        (c) =>
          `<div class="ck${c.live ? '' : ' off'}"><div class="r1"><span class="clm${c.live ? '' : ' off'}">⛓ ${esc(c.label)}</span><span class="nm">${esc(c.holder.name)}</span>` +
          `${c.shared.length ? `<span class="ap">shared with ${esc(c.shared.map((s) => s.name).join(', '))}</span>` : ''}` +
          `<span class="wt">${c.live ? 'live' : c.stale ? 'stale' : 'dead'} · ${esc(ago(c.holder.lastWrite))}</span></div>` +
          `<div class="prompt mono">${esc(home(c.root))}${c.branch && c.branch !== c.label ? ` · ${esc(c.branch)}` : ''}</div></div>`,
      )
      .join('')
  )
}

function crumbs(r) {
  return crumbBase(r) + claimTag(r)
}

function crumbBase(r) {
  const parts = [r.project ? `<span class="pj" style="color:hsl(${projectHue(r.project)} 65% 68%)">${esc(r.project)}</span>` : '']
  if (!showsWhere(r)) return parts.join('') || 'manager'
  if (r.initiative) parts.push(esc(r.initiative))
  const where = r.branch || r.worktree
  parts.push(esc(where || 'no branch'))
  return parts.join(' › ')
}

const heading = (text) => `<div class="hd sec">${text}</div>`
const SECTION = { working: 'Working', idle: 'Idle', blocked: 'Needs you', parked_blocked: 'Blocked, parked', waiting_on_child: 'Waiting on a worker', unknown: 'No signal' }
// Parked-but-blocked sessions are still shown, but apart from "Needs you" so that section and the badge agree.
const sectionOf = (r) => (r.state === 'blocked' && r.parked ? 'parked_blocked' : r.state)
const SECTION_RANK = { blocked: 0, parked_blocked: 1, waiting_on_child: 2, working: 3, idle: 4, unknown: 5 }

function warn(r) {
  return r.warnings?.length ? ` <span class="warn" title="${esc(r.warnings.join('; '))}">▲</span>` : ''
}

/** Hollow dot, reason and wake marker for a parked session; empty for any other. */
function lifeTag(r) {
  if (!r.parked) return ''
  const wake = r.wakeReady ? '<span class="wr">wake ready</span>' : r.parked.wake?.type === 'date' ? `<span class="ap">wakes ${esc(r.parked.wake.value)}</span>` : ''
  const by = r.parked.parkedByName ? `<span class="ap">by ${esc(r.parked.parkedByName)}</span>` : ''
  return `<span class="pd" title="parked">○</span><span class="ap">${esc(r.parked.reason)}</span>${by}${wake}`
}

const bgName = (t) => ((t?.label || t?.kind || 'task').length > 28 ? `${(t.label || t.kind).slice(0, 27)}…` : t?.label || t?.kind || 'task')

const openBg = new Set() // sessions whose background-task list is expanded (click the chip)

/** Running background tasks: a pulsing dot, the first task's name and +N more; click expands the list. Empty when none. */
function bgTag(r) {
  const n = r.tasks?.count || 0
  if (!n) return ''
  const open = openBg.has(r.sessionId)
  return `<span class="bg${open ? ' open' : ''}" title="${open ? 'Hide' : 'Show'} the ${n} background task${n > 1 ? 's' : ''}"><i></i>${esc(bgName(r.tasks.items[0]))}${n > 1 ? ` +${n - 1}` : ''}<b>${open ? '▾' : '▸'}</b></span>`
}

/** The expanded list under a card: kind, name and how long each has run. */
function bgList(r, now = Date.now()) {
  if (!r.tasks?.count || !openBg.has(r.sessionId)) return ''
  return `<div class="bgl">${r.tasks.items.map((t) => `<div><span class="k">${esc(t.kind)}</span><span class="n">${esc(t.label || '(no description)')}</span>${t.startedAt ? `<span class="t">${fmt(now - t.startedAt)}</span>` : ''}</div>`).join('')}</div>`
}

/** Tree status text: the real state first, so a parked-but-blocked session still says it needs you. */
function treeStatus(r) {
  if (r.done) return 'done · d to undo'
  const base = r.state === 'blocked' && r.kind === 'question' ? 'needs your answer' : STATE_LABEL[r.state] || r.state
  const real = r.tasks?.count ? `${base} · ${r.tasks.count} background` : base
  if (!r.parked) return real
  return r.state === 'unknown' ? 'parked · u to unpark' : `${real} · parked · u to unpark`
}

function treeRow(r, depth) {
  const name =
    renaming === r.sessionId
      ? `<input id="renIn" value="${esc(r.name)}" maxlength="120">`
      : `<span class="nm">${esc(r.name)}</span>` + (r.overlay ? `<span class="ap">app: ${esc(r.title)}</span>` : '')
  const hint = r.suggested ? ` <span class="ap">suggested ${esc(r.suggested)} · c to confirm</span>` : ''
  const roll = r.blockedChildren?.length ? ` <span class="ap">${r.blockedChildren.length} blocked</span>` : ''
  return (
    `<div class="q tr s-${r.state}${r.parked ? ' pkd' : ''}${r.done ? ' dn' : ''}${r.sessionId === sel ? ' sel' : ''}" style="margin-left:${depth * 22}px" data-id="${esc(r.sessionId)}">` +
    `<div class="r1"><span class="ri" title="${esc(r.role)}">${ICON[r.role]}</span>${lifeTag(r)}<span class="key${showsWhere(r) && (r.branch || r.worktree) ? '' : ' nb'}">${crumbs(r)}</span>${name}${warn(r)}${hint}${roll}${bgTag(r)}${ctxHtml(r)}` +
    `<span class="wt">${esc(treeStatus(r))}</span></div>${bgList(r)}<span class="go">ENTER ↵ OPEN</span></div>`
  )
}

function renderTree() {
  renderBar()
  $('#side').innerHTML = ''
  document.querySelector('.wrap').classList.remove('has-side')
  const t = tree
  const part = (title, rows) => (rows.length ? heading(title) + rows.map((r) => treeRow(r, 0)).join('') : '')
  const mgr = t.managers.map((m) => treeRow(m, 0) + m.children.map((c) => treeRow(c, 1)).join('')).join('')
  const renameSnap = snapRename()
  $('#list').innerHTML =
    claimsSection() + part('Interface', t.interface) + (mgr ? heading('Project managers') + mgr : '') + part('Workers without a manager', t.orphans) + part('Unclassified', t.unclassified) ||
    `<div class="empty">${hiddenParkedN ? `Everything here is parked (${hiddenParkedN} hidden) · v shows them, p lists them` : 'No sessions.'}</div>`
  if (!nodes.some((r) => r.sessionId === sel) && nodes.length) sel = nodes[0].sessionId
  restoreRename(renameSnap)
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ` · ${ago(ms)}`

/** The Parked view: every parked session with its reason, who parked it, when, and its handoff note. */
function renderParked() {
  renderBar()
  $('#side').innerHTML = ''
  document.querySelector('.wrap').classList.remove('has-side')
  $('#list').innerHTML =
    parkedList
      .map((r) => {
        const p = r.parked
        const wake = r.wakeReady ? ' · <span class="wr">wake ready</span>' : p.wake ? ` · wakes ${esc(p.wake.value)}` : ''
        const by = p.parkedBy ? `by ${esc(p.parkedByName || p.parkedBy)}` : 'by hand'
        return (
          `<div class="q tr pkv${r.archived ? ' arch' : ''}${r.sessionId === sel ? ' sel' : ''}" data-id="${esc(r.sessionId)}">` +
          `<div class="r1"><span class="ri" title="${esc(r.role)}">${ICON[r.role]}</span><span class="pd">○</span><span class="key${showsWhere(r) && (r.branch || r.worktree) ? '' : ' nb'}">${crumbs(r)}</span><span class="nm">${esc(r.name)}</span>` +
          `<span class="wt">${r.archived ? '<span class="ap">archived</span> ' : ''}parked ${esc(when(p.parkedAt))}</span></div>` +
          `<div class="prompt">${esc(p.reason)} · ${by}${wake}</div>` +
          (p.handoffNote ? `<div class="note">${esc(p.handoffNote)}</div>` : '') +
          `<span class="go">ENTER ↵ OPEN · u UNPARK</span></div>`
        )
      })
      .join('') || `<div class="empty">${activeProject() ? 'Nothing parked in this project.' : 'Nothing parked.'}</div>`
  if (!parkedList.some((r) => r.sessionId === sel) && parkedList.length) sel = parkedList[0].sessionId
}

/** Re-filter the server's tree for the current search and draw whichever tree-backed view is open. */
function applyTree() {
  const full = viewTree()
  // Parked sessions stay visible while searching, and the Parked view always needs them.
  const hide = view === 'tree' && !showParked && !filter.trim()
  const shown = hide ? hideParked(full) : { tree: full, hidden: 0 }
  tree = shown.tree
  hiddenParkedN = shown.hidden
  nodes = flatten(tree)
  parkedList = [...flatten(full), ...(full.archived || [])].filter((n) => n.parked && !n.done).sort((a, b) => b.parked.parkedAt - a.parked.parkedAt)
  if (view === 'parked') renderParked()
  else renderTree()
}

function setView(v) {
  view = v
  document.querySelectorAll('.pill[data-view]').forEach((p) => p.classList.toggle('on', p.dataset.view === v))
  $('#flt').hidden = v === 'queue'
  if (v !== 'queue') loadTree()
  else render()
}

let reconciled = false
/** Once the queue and the tree have both loaded, forget a remembered project that has no chip, so it never wakes up later. */
function reconcileProject() {
  if (reconciled || first || !rawTree) return
  reconciled = true
  if (project && !resolveProject(project, projectList())) setProject('')
}

// The tree is fetched in every view: the chip set needs it (parked sessions), so it cannot depend on the view last opened.
async function loadTree() {
  if (renaming) return
  try {
    rawTree = await (await fetch('/api/tree')).json()
    reconcileProject()
    updateAmbient() // the reactor's parked count comes from the tree
    if (view === 'queue') renderBar()
    else applyTree()
    renderPalette()
  } catch {
    /* next poll */
  }
}
setInterval(loadTree, 2000)

/** The context gauge: a thin bar, the exact token count and a clearly approximate share of the reference window. Server-side numbers only. */
function ctxHtml(r) {
  const c = r.ctx
  if (!c) return ''
  return (
    `<span class="cx${c.level ? ` cx-${c.level}` : ''}" title="${esc(c.label)} tokens in context · about ${c.pct}% of a ${esc(c.winLabel)} window (the tokens are exact; the window is a reference, set ZARVIS_CONTEXT_WINDOW to change it)">` +
    `<i class="cx-bar"><i style="width:${Math.min(100, c.pct)}%"></i></i><span class="cx-tx">${esc(c.label)} · ~${c.pct}%</span></span>`
  )
}

/** The interface session inside a big ring: the ring carries its state, the centre its name, the inner arc its context use. Same data-id and .q class, so selection, clicks and Enter work as for any row. */
function ringHtml(r, now) {
  const g = ifaceRing(r, now, OVERDUE_MS)
  const name =
    renaming === r.sessionId
      ? `<input id="renIn" value="${esc(r.name)}" maxlength="120">`
      : `<span class="nm">${esc(r.name)}</span>`
  const arc = g.state === 'blocked' ? `<circle class="ifr-arc" cx="100" cy="100" r="88" transform="rotate(-90 100 100)" style="stroke-dasharray:${(g.p * IFACE_C).toFixed(1)} ${IFACE_C.toFixed(1)}"/>` : ''
  const c = r.ctx
  const ctxArc = c ? `<circle class="ifr-ctxarc${c.level ? ` ifr-ctx-${c.level}` : ''}" cx="100" cy="100" r="72" transform="rotate(-90 100 100)" style="stroke-dasharray:${((Math.min(100, c.pct) / 100) * 2 * Math.PI * 72).toFixed(1)} ${(2 * Math.PI * 72).toFixed(1)}"/>` : ''
  const cmd = g.state === 'blocked' && (r.command || r.tool) ? `<div class="ifr-cmd mono">${esc(r.kind === 'question' ? 'asks' : r.tool)} ${esc(r.command)}</div>` : ''
  return (
    `<div class="q ifr ifr-${g.state}${g.od ? ' od' : ''}${r.sessionId === sel ? ' sel' : ''}" data-id="${esc(r.sessionId)}" title="${esc(r.project)} · ${esc(g.label)} · Enter opens it">` +
    `<div class="ifr-disc"><svg viewBox="0 0 200 200" aria-hidden="true">` +
    `<defs><radialGradient id="ifrGlow"><stop offset="0" stop-color="currentColor" stop-opacity=".30"/><stop offset=".7" stop-color="currentColor" stop-opacity=".08"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient></defs>` +
    `<circle class="ifr-glow" cx="100" cy="100" r="86"/>` +
    `<circle class="ifr-major" cx="100" cy="100" r="98"/>` +
    `<circle class="ifr-ticks" cx="100" cy="100" r="95" style="animation-delay:${loopDelay(now, g.state === 'working' ? 12000 : 30000)}"/>` +
    `<circle class="ifr-hair" cx="100" cy="100" r="91"/>` +
    `<circle class="ifr-base" cx="100" cy="100" r="88"/>${arc}` +
    `<circle class="ifr-inner" cx="100" cy="100" r="79"/>` +
    `<circle class="ifr-ctxtrack" cx="100" cy="100" r="72" transform="rotate(-90 100 100)"/>${ctxArc}</svg>` +
    `<div class="ifr-mid"><span class="ifr-role">${esc(r.project)}</span>${name}<span class="ifr-st">${esc(g.label)}</span>` +
    `<span class="ifr-wt num${g.state === 'off' ? '' : ' wt'}"${g.state === 'off' ? '' : ` data-since="${r.since}"`}>${g.state === 'off' ? '' : fmt(now - r.since)}</span>` +
    (c ? `<span class="ifr-cx mono${c.level ? ` ifr-cx-${c.level}` : ''}" title="about ${c.pct}% of a ${esc(c.winLabel)} window">${esc(c.label)} · ~${c.pct}%</span>` : '') +
    `</div></div>` +
    cmd +
    `<span class="go">ENTER ↵ OPEN</span></div>`
  )
}

function rowHtml(r, now) {
  const working = r.state === 'working'
  const idle = r.state === 'idle'
  const od = r.state === 'blocked' && now - r.since > OVERDUE_MS
  const name =
    renaming === r.sessionId
      ? `<input id="renIn" value="${esc(r.name)}" maxlength="120">`
      : `<span class="nm">${esc(r.name)}</span>` + (r.overlay ? `<span class="ap">app: ${esc(r.title)}</span>` : '')
  const cmd = r.command || r.tool ? `<div class="cmd mono"><span class="tool">${esc(r.kind === 'question' ? 'asks' : r.tool)}</span>${esc(r.command)}</div>` : ''
  return (
    `<div class="q${r.parked ? ' pkd' : ''}${r.state === 'unknown' ? ' ns' : ''}${working || r.state === 'waiting_on_child' ? ' wk' : ''}${idle ? ' wk id' : ''}${od ? ' od' : ''}${r.sessionId === sel ? ' sel' : ''}${fresh.has(r.sessionId) ? ' arrive' : ''}" data-id="${esc(r.sessionId)}">` +
    `<div class="r1"><span class="ri" title="${esc(r.role || '')}">${ICON[r.role] || ''}</span><span class="role ${esc(r.role || '')}">${esc(r.role || '')}</span><span class="key${showsWhere(r) && (r.branch || r.worktree) ? '' : ' nb'}">${crumbs(r)}</span>${lifeTag(r)}${name}${warn(r)}${bgTag(r)}${ctxHtml(r)}<span class="wt num" data-since="${r.since}">${fmt(now - r.since)}</span></div>` +
    `<div class="prompt">${r.state === 'waiting_on_child' ? esc(r.prompt) + ' · Enter jumps to it' : working ? 'Working…' : idle ? (r.tasks?.count ? `Idle · ${r.tasks.count} background task${r.tasks.count > 1 ? 's' : ''} running` : 'Idle — waiting for your next prompt') : esc(r.prompt)}${r.link ? '' : ' <span class="ap">(terminal session: cannot open from here)</span>'}</div>` +
    cmd +
    bgList(r, now) +
    fuseHtml(r, now) +
    (fresh.has(r.sessionId) ? '<i class="sweep"></i>' : '') +
    `<span class="go">ENTER ↵ OPEN</span></div>`
  )
}

/** The wait fuse: a time-driven CSS animation started part-way via a negative delay, so list redraws don't restart it. */
function fuseHtml(r, now) {
  if (r.state !== 'blocked' || r.parked) return ''
  const f = fuseVars(r.since, now, OVERDUE_MS)
  return `<i class="fuse" style="--p:${f.p};--d:${f.d}"></i>`
}

// Event ticker: footer strip of the last dozen state transitions, diffed on each push. It lives outside #list.
let tickerSnap = null
let tickerOpen = true
try { tickerOpen = localStorage.getItem('zarvis.ticker') !== '0' } catch { /* storage blocked */ }
function paintTickerState() {
  document.body.classList.toggle('tk-off', !tickerOpen)
  $('#tkLbl').setAttribute('aria-expanded', String(tickerOpen))
}
function setTicker(open) {
  tickerOpen = open
  try { localStorage.setItem('zarvis.ticker', open ? '1' : '0') } catch { /* storage blocked */ }
  paintTickerState()
  planScroll()
}
let tickerItems = [] // newest first: diffed transitions and events pushed through `npm run event`
function paintTicker(added, seed) {
  const box = $('#tkTrack')
  const fresh = new Set(added)
  const now = Date.now()
  box.replaceChildren(...tickerItems.map((ev) => {
    const el = document.createElement('span')
    el.className = `ev mono ${ev.pushed ? `pushed k-${evKindClass(ev.kind)}` : ev.kind}${fresh.has(ev) && !seed ? ' new' : ''}`
    el.append(`${evTime(ev.at, now)} `)
    if (ev.pushed) {
      const kd = document.createElement('i')
      kd.className = 'kd'
      kd.textContent = ev.kind
      el.append(kd, ' ')
      if (ev.name) el.append(Object.assign(document.createElement('em'), { textContent: `${ev.name} ` }))
    }
    el.append(Object.assign(document.createElement('b'), { textContent: ev.text }))
    const href = ev.pushed ? safeUrl(ev.url) : ''
    if (href) {
      const a = Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener noreferrer', textContent: '↗', title: href })
      a.setAttribute('aria-label', 'open link')
      el.append(' ', a)
    }
    if (el.classList.contains('new')) setTimeout(() => el.classList.remove('new'), 400)
    return el
  }))
}
function mergeInto(incoming, seed = false) {
  const r = mergeTicker(tickerItems, incoming, TICKER_MAX)
  if (!r.added.length && r.items.length === tickerItems.length) return
  tickerItems = r.items
  paintTicker(r.added, seed)
  planScroll(r.added.length > 0 && !seed) // news jumps to the newest entry and rests there before the scroll resumes
}

// Auto-scroll through a long history: newest first, scroll from the oldest end to the newest, rest, restart.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
let scrollAnim = null
let scrollTimer = 0
const holds = new Set() // 'hover' / 'focus' / 'hidden': why the scroll is paused right now
let runPending = false
function stopScroll() {
  clearTimeout(scrollTimer)
  runPending = false
  scrollAnim?.cancel()
  scrollAnim = null
  $('#tkTrack').style.transform = ''
}
function planScroll(snapToNewest = false) {
  const track = $('#tkTrack')
  const view = $('#tkList')
  stopScroll()
  if (!tickerOpen) return
  const plan = scrollPlan({ count: tickerItems.length, contentW: track.scrollWidth, viewW: view.clientWidth, reduced: reduceMotion.matches })
  if (!plan.scroll) return
  const run = () => {
    if (holds.size) { runPending = true; return }
    scrollAnim?.cancel()
    scrollAnim = track.animate([{ transform: `translateX(${-plan.distance}px)` }, { transform: 'translateX(0px)' }], { duration: plan.duration, easing: 'linear', fill: 'forwards' })
    scrollAnim.onfinish = () => { scrollTimer = setTimeout(run, TICKER_PAUSE_MS) }
  }
  if (snapToNewest) {
    scrollTimer = setTimeout(run, TICKER_PAUSE_MS) // sit on the newest entry first
    runPending = false
  } else run()
}
function hold(reason, on) {
  on ? holds.add(reason) : holds.delete(reason)
  if (holds.size) scrollAnim?.pause()
  else if (runPending) { runPending = false; planScroll() }
  else scrollAnim?.play()
}
$('#tkList').addEventListener('mouseenter', () => hold('hover', true))
$('#tkList').addEventListener('mouseleave', () => hold('hover', false))
$('#tkList').addEventListener('focusin', () => hold('focus', true))
$('#tkList').addEventListener('focusout', () => hold('focus', false))
document.addEventListener('visibilitychange', () => hold('hidden', document.hidden))
reduceMotion.addEventListener?.('change', () => planScroll())
let resizeTimer = 0
// The strip's own size is what matters: this also fires once it is first laid out and when the window or the label changes it.
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => planScroll(), 200) }).observe($('#tkList'))
function pushEvents(rows) {
  const events = diffEvents(tickerSnap, rows)
  tickerSnap = snapshot(rows)
  const at = Date.now()
  mergeInto(events.map((ev) => ({ ...ev, at, key: `t${at}|${ev.id}|${ev.text}`, sessionId: ev.id })))
}
/** Events pushed by sessions and scripts (server payload). The first batch seeds the strip without animating. */
let pushedSeeded = false
function pushPushed(list) {
  if (!Array.isArray(list)) return
  mergeInto(list.filter((e) => e && typeof e.text === 'string').map((e) => ({ ...e, pushed: true })), !pushedSeeded)
  pushedSeeded = true
}
$('#tkLbl').addEventListener('click', () => setTicker(!tickerOpen))
paintTickerState()

/** Ambient edge glow on <body>: amber while anything needs you, red once any wait is overdue. Not filtered: it is the attention signal. */
function updateAmbient(now = Date.now()) {
  const g = glowState(queue, now, OVERDUE_MS)
  document.body.classList.toggle('has-blocked', g !== '')
  document.body.classList.toggle('has-od', g === 'overdue')
  const att = attention(queue, now, OVERDUE_MS)
  updateTab(att)
  updateReactor(att)
  updateDials(now)
  renderRail()
}

/** The two header dials. Change-only, like the reactor. */
let dialKey = ''
let hookStatus = ''
function updateDials(now) {
  const w = waitDial(queue, now, OVERDUE_MS)
  const h = hookDial(hookStatus)
  const key = `${w.p.toFixed(3)}|${w.text}|${w.state}|${w.count}|${h.state}`
  if (key === dialKey) return
  dialKey = key
  const wd = $('#dialWait')
  wd.className = `dial ${w.state}`
  wd.querySelector('.dl-fg').style.strokeDasharray = dialDash(w.p)
  if (wd.querySelector('.dl-tx').textContent !== w.text) { wd.querySelector('.dl-tx').textContent = w.text; flicker(wd.querySelector('.dl-tx')) }
  wd.title = w.count ? `Longest wait ${w.text} · ${w.count} need${w.count === 1 ? 's' : ''} you · the ring fills toward the 5 minute overdue mark` : 'Longest wait: nothing needs you'
  const hd = $('#dialHook')
  hd.className = `dial ${h.state}`
  hd.querySelector('.dl-fg').style.strokeDasharray = dialDash(h.p)
  hd.title = { live: 'Hook events are arriving', stale: 'Hook events have gone quiet', absent: 'No hook markers on disk', unknown: 'Hook status unknown' }[h.state]
}

// Project rail: a ring gauge per project (blocked / working / idle / parked), click to filter. Wide windows only (CSS).
let railOpen = true
try { railOpen = localStorage.getItem('zarvis.rail') !== '0' } catch { /* storage blocked */ }
document.body.classList.toggle('rail-on', railOpen)
let railKey = ''
function renderRail() {
  const rail = $('#rail')
  if (!railOpen) return
  const nodes = rawTree ? [...flatten(rawTree), ...(rawTree.archived || [])] : []
  const gauges = projectGauges(queue, nodes)
  const cur = activeProject()
  const key = JSON.stringify([gauges.map((g) => [g.project, g.counts]), cur])
  if (key === railKey) return
  railKey = key
  const R = 15
  rail.replaceChildren()
  const hd = document.createElement('div')
  hd.className = 'rl-hd'
  hd.textContent = 'Projects'
  rail.append(hd)
  if (!gauges.length) rail.append(Object.assign(document.createElement('div'), { className: 'rl-empty', textContent: 'No sessions yet' }))
  for (const g of gauges) {
    const el = document.createElement('div')
    el.className = `rl-g${g.project === cur ? ' on' : ''}`
    el.dataset.p = g.project
    el.title = `${g.project}: ${g.counts.blocked} need you, ${g.counts.working} working, ${g.counts.idle} idle, ${g.counts.parked} parked`
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 40 40')
    svg.setAttribute('width', '34')
    svg.setAttribute('height', '34')
    const grp = document.createElementNS(NS, 'g')
    grp.setAttribute('transform', 'rotate(-90 20 20)')
    const base = document.createElementNS(NS, 'circle')
    base.setAttribute('cx', '20'); base.setAttribute('cy', '20'); base.setAttribute('r', String(R))
    base.setAttribute('fill', 'none'); base.setAttribute('stroke', 'var(--edge)'); base.setAttribute('stroke-width', '5')
    grp.append(base)
    for (const a of g.arcs) {
      const c = document.createElementNS(NS, 'circle')
      c.setAttribute('class', `rl-a ${a.key}`)
      c.setAttribute('cx', '20'); c.setAttribute('cy', '20'); c.setAttribute('r', String(R))
      c.style.strokeDasharray = a.dash
      c.style.strokeDashoffset = a.offset
      grp.append(c)
    }
    svg.append(grp)
    const txt = document.createElement('div')
    txt.className = 'rl-txt'
    const name = Object.assign(document.createElement('div'), { className: 'rl-n', textContent: g.project })
    const cnt = document.createElement('div')
    cnt.className = 'rl-c mono'
    const parts = []
    if (g.counts.blocked) parts.push(Object.assign(document.createElement('span'), { className: 'nd', textContent: `${g.counts.blocked} need` }))
    if (g.counts.working) parts.push(Object.assign(document.createElement('span'), { className: 'rn', textContent: `${g.counts.working} run` }))
    if (!parts.length) parts.push(document.createTextNode(`${g.total} total`))
    parts.forEach((p, i) => { if (i) cnt.append(' · '); cnt.append(p) })
    txt.append(name, cnt)
    el.append(svg, txt)
    rail.append(el)
  }
}
$('#rail').addEventListener('click', (e) => {
  const g = e.target.closest('.rl-g')
  if (g) setProject(activeProject() === g.dataset.p ? '' : g.dataset.p)
})
function setRail(open) {
  railOpen = open
  try { localStorage.setItem('zarvis.rail', open ? '1' : '0') } catch { /* storage blocked */ }
  document.body.classList.toggle('rail-on', open)
  railKey = ''
  renderRail()
}

/** The header arc reactor: only touches the DOM when what it shows changes. */
let reactorKey = ''
function updateReactor(att) {
  const counts = reactorCounts(queue, rawTree ? [...flatten(rawTree), ...(rawTree.archived || [])].filter((n) => n.parked && !n.done).length : null)
  const st = reactorState(counts, att)
  const text = reactorText(counts)
  const key = `${JSON.stringify(counts)}|${st.core}|${st.spin}`
  if (key === reactorKey) return
  reactorKey = key
  const el = $('#reactor')
  el.classList.toggle('amber', st.core === 'amber')
  el.classList.toggle('red', st.core === 'red')
  el.classList.toggle('spin', st.spin)
  el.setAttribute('aria-label', `${counts.blocked} need you, ${counts.working} working, ${counts.idle} idle, ${counts.parked} parked`)
  if ($('#reactorTxt').textContent !== text) { $('#reactorTxt').textContent = text; flicker($('#reactorTxt')) }
  const arcs = reactorArcs(counts)
  for (const a of arcs) {
    const c = el.querySelector(`.rx-arc.${a.key}`)
    c.style.strokeDasharray = a.dash
    c.style.strokeDashoffset = a.offset
  }
}

const FAVICON_COLORS = { idle: '#4d6678', amber: '#ffb347', red: '#ff4d5e' }
let faviconKey = ''
/** Tab title and a canvas favicon ring; the canvas is redrawn only when its picture would change. */
function updateTab(att) {
  const title = tabTitle(att)
  if (document.title !== title) document.title = title
  const fav = faviconState(att)
  if (fav.key === faviconKey) return
  faviconKey = fav.key
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')
    g.lineWidth = 8
    g.strokeStyle = FAVICON_COLORS[fav.color]
    g.beginPath()
    g.arc(32, 32, 26, 0, Math.PI * 2)
    g.stroke()
    if (fav.label) {
      g.fillStyle = FAVICON_COLORS[fav.color]
      g.font = `bold ${fav.label.length > 1 ? 26 : 34}px system-ui, sans-serif`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(fav.label, 32, 35)
    }
    let link = document.querySelector('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = c.toDataURL('image/png')
  } catch { /* no canvas: the title still carries the count */ }
}
document.addEventListener('visibilitychange', () => document.body.classList.toggle('tab-hidden', document.hidden))

/** Live pushes redraw the list; keep what the user has typed into the rename box (and the caret) across it. */
function snapRename() {
  const i = renaming && $('#renIn')
  return i ? { value: i.value, start: i.selectionStart, end: i.selectionEnd } : null
}
function restoreRename(snap) {
  if (!renaming) return
  const i = $('#renIn')
  if (!i) return
  if (snap) {
    i.value = snap.value
    i.setSelectionRange(snap.start, snap.end)
  } else i.select() // first draw: select the old name so typing replaces it
  if (document.activeElement !== i) i.focus()
}

function setRoleFilter(r) {
  roleFilter = r
  try { localStorage.setItem('zarvis.role', r) } catch { /* storage blocked */ }
  render()
}

function setShowParked(on) {
  showParked = on
  try { localStorage.setItem('zarvis.showParked', on ? '1' : '0') } catch { /* storage blocked */ }
  if (rawTree) applyTree()
  else render()
}

function setProject(p) {
  project = p
  try { localStorage.setItem('zarvis.project', p) } catch { /* storage blocked */ }
  renderRail()
  if (view !== 'queue' && rawTree) applyTree()
  render()
}

/** The project filter bar: All plus one chip per project (needs-you and working counts), shown with 2+ projects. */
function renderBar() {
  const bar = $('#projbar')
  const list = projectList()
  const cur = activeProject()
  if (list.length < 2 && !(view === 'queue' && queue.length) && view !== 'tree') { bar.hidden = true; bar.innerHTML = ''; return }
  bar.hidden = false
  const counts = (e) => `${e.blocked ? `<b class="nd">${e.blocked}</b>` : ''}${e.working ? `<b class="rn">${e.working}</b>` : ''}`
  const all = list.reduce((a, e) => ({ blocked: a.blocked + e.blocked, working: a.working + e.working }), { blocked: 0, working: 0 })
  // Each view's own count of what the filter hides: blocked in the queue, parked in the Parked view, none in Roles.
  const hiddenN = view === 'queue' ? hiddenBlocked(queue, cur, roleFilter) : view === 'parked' ? hiddenParked(rawTree ? [...flatten(rawTree), ...(rawTree.archived || [])] : [], cur) : 0
  const hiddenWhat = view === 'parked' ? 'parked' : 'blocked'
  const hiddenWhere = view === 'queue' && roleFilter ? 'outside the filters' : 'in other projects'
  bar.innerHTML =
    `<span class="chip${cur ? '' : ' on'}" data-p="">All ${counts(all)}</span>` +
    list.map((e) => `<span class="chip${e.project === cur ? ' on' : ''}" data-p="${esc(e.project)}" style="--ph:${projectHue(e.project)}">${esc(e.project)} ${counts(e)}</span>`).join('') +
    (hiddenN ? `<span class="chip hid" data-p="" title="Show all projects">${hiddenN} ${hiddenWhat} ${hiddenWhere}</span>` : '') +
    (view === 'queue' ? ROLE_FILTERS.map((r) => `<span class="chip rl${roleFilter === r ? ' on' : ''}" data-r="${r}">${r}s <kbd>${r[0]}</kbd></span>`).join('') : '') +
    (view === 'tree' ? `<span class="chip pv${showParked ? ' on' : ''}" data-v="parked" title="v toggles">parked ${showParked ? 'shown' : filter.trim() ? 'shown (searching)' : `hidden${hiddenParkedN ? ` (${hiddenParkedN})` : ''}`} <kbd>v</kbd></span>` : '') +
    '<span class="ap g">g project</span>'
}
$('#projbar').addEventListener('click', (e) => {
  const c = e.target.closest('.chip')
  if (c && c.dataset.v) setShowParked(!showParked)
  else if (c && c.dataset.r) setRoleFilter(toggleRole(roleFilter, c.dataset.r))
  else if (c) { if (roleFilter && c.classList.contains('hid')) setRoleFilter(''); setProject(c.dataset.p) }
})

function render() {
  renderBar()
  if (view === 'tree') return renderTree()
  if (view === 'parked') return renderParked()
  const vq = visibleQueue()
  const badge = String(vq.filter((r) => r.state === 'blocked' && !r.parked).length || '') // what the "Needs you" section holds
  if ($('#qb').textContent !== badge) { $('#qb').textContent = badge; flicker($('#qb')) }
  const list = $('#list')
  const side = $('#side')
  const renameSnap = snapRename()
  if (!vq.length) {
    side.innerHTML = ''
    document.querySelector('.wrap').classList.remove('has-side')
    list.innerHTML = `<div class="empty">${queue.length ? 'Nothing in this project.' : 'Nothing waiting on you.'}</div>`
    return
  }
  if (!vq.some((r) => r.sessionId === sel)) sel = vq[0].sessionId
  const now = Date.now()
  const iface = vq.filter((r) => r.role === 'interface')
  const rest = vq.filter((r) => r.role !== 'interface')
  document.querySelector('.wrap').classList.toggle('has-side', iface.length > 0)
  side.innerHTML = iface.length ? heading('Interface') + iface.map((r) => ringHtml(r, now)).join('') : ''
  let last = ''
  list.innerHTML =
    rest
      .map((r) => {
        const head = sectionOf(r) !== last ? heading(SECTION[sectionOf(r)]) : ''
        last = sectionOf(r)
        return head + rowHtml(r, now)
      })
      .join('') || (iface.length ? '<div class="empty">Nothing else waiting on you.</div>' : '')
  restoreRename(renameSnap)
}

function setQueue(q) {
  queue = [...q].sort((a, b) => (SECTION_RANK[sectionOf(a)] ?? 9) - (SECTION_RANK[sectionOf(b)] ?? 9)) // stable: the server's order within a section
  // New arrivals draw the eye once; the very first load is not an arrival.
  fresh = new Set(first ? [] : q.filter((r) => !seen.has(r.sessionId)).map((r) => r.sessionId))
  seen = new Set(q.map((r) => r.sessionId))
  first = false
  pushEvents(queue)
  updateAmbient()
  reconcileProject()
  if (renaming && !q.some((r) => r.sessionId === renaming)) renaming = null
  render()
  renderPalette()
}

function toast(msg, ms = 2600) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toast.t)
  toast.t = setTimeout(() => t.classList.remove('on'), ms)
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

async function openSel() {
  const r = items().find((x) => x.sessionId === sel)
  if (!r) return
  // A manager with a blocked worker: the leaf-only rule says go to the worker that is blocked.
  const target = r.blockedChildren?.[0]?.sessionId || r.sessionId
  const { ok, data } = await post('/api/open', { sessionId: target })
  toast(ok ? `Opening “${r.name}” in Claude…${data.dryRun ? ' (dry run)' : ''}` : data.error || 'Open failed')
}

async function newSession(role) {
  const r = items().find((x) => x.sessionId === sel)
  // A worker started with a manager selected is attached to it; the server builds the tag.
  const parent = role === 'worker' && r?.role === 'manager' ? r.sessionId : ''
  const { ok, data } = await post('/api/new', { sessionId: r?.sessionId, role, parent })
  const where = data.folder ? ` in ${data.folder.split(/[\\/]/).pop()}` : ''
  const tag = data.marker ? ` with ${data.marker} in the prompt box (not sent)` : ''
  toast(ok ? `Opening a new Claude Code session${where}${tag}…${data.dryRun ? ' (dry run)' : ''}` : data.error || 'New session failed', data.marker ? 7000 : 2600)
}

async function lifecycle(path, body, label, back) {
  const { ok, data } = await post(path, body)
  if (!ok) return toast(data.error || 'Failed')
  undo = back ? { label, run: back } : null
  toast(back ? `${label} · z to undo` : label)
  loadTree()
}

function unparkSel() {
  const r = items().find((x) => x.sessionId === sel)
  if (!r) return
  if (!r.parked) return toast('Not parked (Shift+P parks it)')
  const prev = r.parked
  lifecycle('/api/unpark', { sessionId: r.sessionId }, `Unparked “${r.name}”`, () => post('/api/park', { sessionId: r.sessionId, ...prev, wake: prev.wake }))
}

function parkSel() {
  const r = items().find((x) => x.sessionId === sel)
  if (!r) return
  if (r.parked) {
    const prev = r.parked
    return lifecycle('/api/unpark', { sessionId: r.sessionId }, `Unparked “${r.name}”`, () => post('/api/park', { sessionId: r.sessionId, ...prev }))
  }
  parking = { sessionId: r.sessionId, name: r.name }
  $('#parkHd').textContent = `Park “${r.name}”`
  for (const id of ['#parkReason', '#parkDate', '#parkNote']) $(id).value = ''
  $('#ovPark').classList.add('on')
  $('#parkReason').focus()
}

function closePark() {
  parking = null
  $('#ovPark').classList.remove('on')
  document.activeElement?.blur()
}

async function commitPark() {
  const reason = $('#parkReason').value.trim()
  if (!reason) return toast('A park needs a one-line reason')
  const { sessionId, name } = parking
  const date = $('#parkDate').value.trim()
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Wake date must be YYYY-MM-DD, or blank')
  const body = { sessionId, reason, wake: date ? { type: 'date', value: date } : null, handoffNote: $('#parkNote').value }
  closePark()
  await lifecycle('/api/park', body, `Parked “${name}”`, () => post('/api/unpark', { sessionId }))
}

function doneSel() {
  const r = items().find((x) => x.sessionId === sel)
  if (!r) return
  const done = !r.done
  lifecycle('/api/done', { sessionId: r.sessionId, done }, done ? `Marked “${r.name}” done` : `Brought back “${r.name}”`, () => post('/api/done', { sessionId: r.sessionId, done: !done }))
}

async function undoLast() {
  if (!undo) return toast('Nothing to undo')
  const { label, run } = undo
  undo = null
  await run()
  toast(`Undid: ${label}`)
  loadTree()
}

for (const id of ['#parkReason', '#parkDate', '#parkNote']) {
  $(id).addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') closePark()
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || id !== '#parkNote')) { e.preventDefault(); commitPark() }
  })
}
$('#parkGo').addEventListener('click', () => parking && commitPark())

$('#flt').addEventListener('input', (e) => { filter = e.target.value; if (rawTree) applyTree() })
$('#flt').addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Escape') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); e.target.blur() }
  else if (e.key === 'Enter') e.target.blur()
})

async function commitRename() {
  const id = renaming
  const val = $('#renIn')?.value ?? ''
  renaming = null
  const r = items().find((x) => x.sessionId === id)
  // Typing the app's own title back is the same as clearing the overlay.
  await post('/api/rename', { sessionId: id, name: r && val.trim() === r.title ? '' : val })
}

async function classifySel(role) {
  const r = items().find((x) => x.sessionId === sel)
  if (!r) return
  const { ok, data } = await post('/api/classify', { sessionId: r.sessionId, role })
  toast(ok ? (role ? `“${r.name}” is now ${/^[aeiou]/.test(role) ? 'an' : 'a'} ${role}` : `“${r.name}” unclassified`) : data.error || 'Classify failed')
  loadTree()
}

async function classifyGroup() {
  const todo = tree.unclassified.filter((r) => !r.suggested)
  for (const r of todo) await post('/api/classify', { sessionId: r.sessionId, role: 'worker' })
  toast(todo.length ? `Classified ${todo.length} as workers` : 'Nothing to classify')
  loadTree()
}

/** Sessions that could become workers of `mgr`: unclassified ones, and workers of other managers. */
function pickCandidates(mgr) {
  const mine = new Set(mgr.children.map((c) => c.sessionId))
  return [...tree.unclassified, ...tree.orphans, ...tree.managers.filter((m) => m.sessionId !== mgr.sessionId).flatMap((m) => m.children)].filter((r) => !mine.has(r.sessionId))
}

function pickRows() {
  const f = $('#pickIn').value.trim().toLowerCase()
  return pick.rows.filter((r) => !f || `${r.name} ${r.title} ${r.project}`.toLowerCase().includes(f))
}

function renderPick() {
  const rows = pickRows()
  pick.idx = Math.min(pick.idx, Math.max(0, rows.length - 1))
  $('#pickHd').textContent = `Attach to “${pick.mgr.name}” (${pick.checked.size} ticked)`
  $('#pickList').innerHTML =
    rows.map((r, i) => `<div class="pk${i === pick.idx ? ' cur' : ''}" data-i="${i}"><span class="bx">${pick.checked.has(r.sessionId) ? '[x]' : '[ ]'}</span><span>${esc(r.name)}</span><span class="ap">${esc(r.project)}${r.role === 'worker' ? ' · worker elsewhere' : ''}</span></div>`).join('') ||
    '<div class="empty" style="font-size:13px;padding:12px 4px">No matches.</div>'
  document.querySelector('.pk.cur')?.scrollIntoView({ block: 'nearest' })
}

function openPick() {
  const mgr = items().find((x) => x.sessionId === sel)
  if (view !== 'tree' || mgr?.role !== 'manager') return toast('Select a manager in the role tree first (t)')
  pick = { mgr, rows: pickCandidates(mgr), checked: new Set(), idx: 0 }
  $('#pickIn').value = ''
  $('#ovPick').classList.add('on')
  renderPick()
  $('#pickIn').focus()
}

function closePick() {
  pick = null
  $('#ovPick').classList.remove('on')
  $('#pickIn').blur()
}

async function commitPick() {
  const { mgr, checked } = pick
  closePick()
  if (!checked.size) return toast('Nothing ticked')
  for (const id of checked) await post('/api/classify', { sessionId: id, role: 'worker', parent: mgr.sessionId })
  toast(`Attached ${checked.size} to “${mgr.name}”`)
  loadTree()
}

$('#pickIn').addEventListener('input', () => { pick.idx = 0; renderPick() })
$('#pickIn').addEventListener('keydown', (e) => {
  e.stopPropagation()
  const rows = pickRows()
  if (e.key === 'Escape') closePick()
  else if (e.key === 'ArrowDown') { e.preventDefault(); pick.idx = Math.min(rows.length - 1, pick.idx + 1); renderPick() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pick.idx = Math.max(0, pick.idx - 1); renderPick() }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitPick() }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const r = rows[pick.idx]
    if (r) pick.checked.has(r.sessionId) ? pick.checked.delete(r.sessionId) : pick.checked.add(r.sessionId)
    renderPick()
  }
})
$('#pickList').addEventListener('click', (e) => {
  const row = e.target.closest('.pk')
  const r = row && pickRows()[Number(row.dataset.i)]
  if (!r) return
  pick.checked.has(r.sessionId) ? pick.checked.delete(r.sessionId) : pick.checked.add(r.sessionId)
  pick.idx = Number(row.dataset.i)
  renderPick()
})
$('#pickGo').addEventListener('click', () => pick && commitPick())

function toggleParkedShown() {
  if (view !== 'tree') return toast('v shows or hides parked sessions on the Roles page (t)')
  setShowParked(!showParked)
  toast(showParked ? 'Roles: parked sessions shown' : 'Roles: parked sessions hidden · p lists them')
}

/** `m` / `w` (or their palette entries): the queue role filter; the same key clears it. */
function toggleRoleKey(k) {
  if (view !== 'queue') return toast('The role filter applies to the queue (h)')
  const next = toggleRole(roleFilter, k === 'm' ? 'manager' : 'worker')
  setRoleFilter(next)
  toast(next ? `Showing ${next}s only · ${k} again clears` : 'Role filter off')
}

const stepProject = (d) => setProject(cycleProject(projectList().map((p) => p.project), activeProject(), d))
const startRename = () => { renaming = sel; render() }
const startClassify = () => { awaitingRole = true; toast('Classify: i interface · m manager · w worker · x clear') }
const startNew = () => { awaitingNew = true; toast('New session as: i interface · m manager · w worker · p plain · Esc cancels', 60000) }

/** `i`: select the interface session; with several, each press goes to the next one. */
function jumpToInterface() {
  const all = items().filter((r) => r.role === 'interface')
  if (!all.length) return toast('No interface session')
  const i = all.findIndex((r) => r.sessionId === sel)
  sel = all[(i + 1) % all.length].sessionId
  render()
  document.querySelector('.q.sel')?.scrollIntoView({ block: 'nearest' })
}

function move(d) {
  const list = items()
  const i = list.findIndex((r) => r.sessionId === sel)
  const n = Math.min(list.length - 1, Math.max(0, i + d))
  if (list[n]) sel = list[n].sessionId
  render()
  document.querySelector('.q.sel')?.scrollIntoView({ block: 'nearest' })
}

// ---- Command palette (Cmd/Ctrl-K): sessions and every key action, fuzzy-searched ----
const nextViewCmd = (d) => setView(nextView(view, d))
/** One handler per command id: each calls the same function its key does. */
const RUN = {
  'view-queue': () => setView('queue'),
  'view-tree': () => setView('tree'),
  'view-parked': () => setView('parked'),
  'view-next': () => nextViewCmd(1),
  'view-prev': () => nextViewCmd(-1),
  search: () => (view !== 'queue' ? $('#flt').focus() : toast('Search applies to the Roles and Parked views (t, p)')),
  'project-next': () => stepProject(1),
  'project-prev': () => stepProject(-1),
  'project-all': () => setProject(''),
  'role-manager': () => toggleRoleKey('m'),
  'role-worker': () => toggleRoleKey('w'),
  'toggle-parked': toggleParkedShown,
  open: openSel,
  interface: jumpToInterface,
  rename: () => (items().length ? startRename() : toast('Nothing to rename')),
  park: () => (items().length ? parkSel() : toast('Nothing to park')),
  unpark: unparkSel,
  done: () => (items().length ? doneSel() : toast('Nothing to mark done')),
  undo: undoLast,
  attach: openPick,
  'new-interface': () => newSession('interface'),
  'new-manager': () => newSession('manager'),
  'new-worker': () => newSession('worker'),
  'new-plain': () => newSession(''),
  'classify-interface': () => classifySel('interface'),
  'classify-manager': () => classifySel('manager'),
  'classify-worker': () => classifySel('worker'),
  'classify-clear': () => classifySel(''),
  'classify-group': () => (view === 'tree' ? classifyGroup() : toast('Classify all applies on the Roles page (t)')),
  rail: () => setRail(!railOpen),
  ticker: () => setTicker(!tickerOpen),
  help: toggleHelp,
}

/** Every live session once: queue rows first, then tree-only ones (done sessions stay out; / finds those). */
function paletteSessions() {
  const seenIds = new Set()
  const out = []
  for (const r of [...queue, ...(rawTree ? [...flatten(rawTree), ...(rawTree.archived || [])] : [])]) {
    if (r.done || seenIds.has(r.sessionId)) continue
    seenIds.add(r.sessionId)
    out.push(r)
  }
  return out
}

const paletteEntries = () => paletteSearch(palette.q, paletteSessions(), buildCommands(projectList().map((p) => p.project)), { stateLabel: (r) => STATE_LABEL[r.state] || r.state })

function markName(label, idx) {
  if (!idx.length) return esc(label)
  const on = new Set(idx)
  return [...label].map((ch, i) => (on.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('')
}

function renderPalette(force) {
  if (!palette) return
  const entries = paletteEntries()
  const h = keepHighlight(entries, palette.key, palette.idx)
  palette.key = h.key
  palette.idx = h.idx
  palette.entries = entries
  const sig = JSON.stringify([entries.map((e) => [e.key, e.label, e.type === 'session' ? [e.ref.state, e.ref.project, e.ref.branch || e.ref.worktree, e.ref.role, !!e.ref.parked] : e.ref.key]), h.idx])
  if (!force && sig === palette.sig) return // a live push that changes nothing visible leaves the list alone
  palette.sig = sig
  const list = $('#palList')
  const keep = list.scrollTop
  list.innerHTML =
    entries
      .map((e, i) => {
        const cur = i === h.idx ? ' cur' : ''
        if (e.type === 'command') return `<div class="pl cmd${cur}" role="option" id="pl${i}" data-i="${i}" aria-selected="${!!cur}"><span class="pt">${esc(e.ref.group)}</span><span class="pn">${markName(e.label, e.idx)}</span>${e.ref.key ? `<span class="pk2">${e.ref.key.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</span>` : ''}</div>`
        const r = e.ref
        const where = showsWhere(r) ? r.branch || r.worktree || '' : ''
        return `<div class="pl ses s-${esc(r.state)}${cur}" role="option" id="pl${i}" data-i="${i}" aria-selected="${!!cur}"><span class="pt">${ICON[r.role] || '?'} ${esc(r.role)}</span><span class="pn">${markName(e.label, e.idx)}</span><span class="pm">${esc([r.project, where].filter(Boolean).join(' › '))}</span><span class="ps">${esc(r.parked ? 'parked' : STATE_LABEL[r.state] || r.state)}</span></div>`
      })
      .join('') || '<div class="pe">No matches.</div>'
  list.scrollTop = keep
  $('#palIn').setAttribute('aria-activedescendant', `pl${h.idx}`)
  list.querySelector('.pl.cur')?.scrollIntoView({ block: 'nearest' })
}

function openPalette() {
  if (palette || renaming || pick || parking) return
  $('#ovHelp').classList.remove('on')
  palette = { q: '', key: '', idx: 0, sig: '', entries: [], back: document.activeElement }
  $('#palIn').value = ''
  $('#ovPal').classList.add('on')
  renderPalette(true)
  $('#palIn').focus()
}

function closePalette(restore = true) {
  if (!palette) return
  const back = palette.back
  palette = null
  $('#ovPal').classList.remove('on')
  $('#palIn').blur()
  if (restore && back && back !== document.body && document.contains(back)) back.focus()
}

/** Select a session the way clicking its row does; widen the view first when a filter or the view itself hides it. */
function jumpToSession(id) {
  const visible = () => items().some((x) => x.sessionId === id)
  if (!visible()) {
    const row = paletteSessions().find((x) => x.sessionId === id)
    if (view === 'queue') {
      if (roleFilter) setRoleFilter('')
      if (!visible() && project) setProject('')
      if (!visible() && !queue.some((x) => x.sessionId === id)) setView(row?.parked ? 'parked' : 'tree')
    } else {
      if (filter) { filter = ''; $('#flt').value = ''; if (rawTree) applyTree() }
      if (project) setProject('')
      if (!visible()) setView(row?.parked ? 'parked' : queue.some((x) => x.sessionId === id) ? 'queue' : 'tree')
    }
  }
  sel = id
  render()
  document.querySelector('.q.sel')?.scrollIntoView({ block: 'nearest' })
}

function runPalette(i) {
  const e = palette?.entries[i]
  if (!e) return
  closePalette()
  if (e.type === 'session') return jumpToSession(e.ref.sessionId)
  const id = e.ref.id
  if (id.startsWith('project:')) return setProject(id.slice(8))
  RUN[id]?.()
}

window.addEventListener('keydown', (e) => {
  if (!(e.key === 'k' || e.key === 'K') || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
  if (renaming || pick || parking) return // never from inside the rename box, nor over another dialog
  e.preventDefault()
  e.stopPropagation()
  palette ? closePalette() : openPalette()
}, true)

$('#palIn').addEventListener('input', (e) => { palette.q = e.target.value; palette.key = ''; palette.idx = 0; renderPalette() })
$('#palIn').addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (!palette) return
  const move = (d) => { e.preventDefault(); palette.idx = stepHighlight(palette.entries, palette.idx, d); palette.key = palette.entries[palette.idx]?.key || ''; renderPalette() }
  if (e.key === 'Escape') { e.preventDefault(); closePalette() }
  else if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) move(1)
  else if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) move(-1)
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palette.idx) }
  else if (e.key === 'Tab') e.preventDefault() // focus stays in the input
})
$('#palIn').addEventListener('blur', () => { if (palette) setTimeout(() => palette && $('#palIn').focus(), 0) }) // trap focus
$('#palList').addEventListener('mousedown', (e) => e.preventDefault()) // a click must not blur the input
$('#palList').addEventListener('click', (e) => { const r = e.target.closest('.pl'); if (r) runPalette(Number(r.dataset.i)) })
$('#palList').addEventListener('mousemove', (e) => {
  const r = e.target.closest('.pl')
  if (!r || !palette || Number(r.dataset.i) === palette.idx) return
  palette.idx = Number(r.dataset.i)
  palette.key = palette.entries[palette.idx]?.key || ''
  renderPalette()
})
$('#ovPal').addEventListener('mousedown', (e) => { if (e.target.id === 'ovPal') { e.preventDefault(); closePalette() } })
$('#palHint').addEventListener('click', () => (palette ? closePalette() : openPalette()))

// Tab is handled on window in the capture phase, like the other keyboard-first pages: nothing below (a pending
// n/c second key, a dialog's own handlers) can swallow it, so the browser never gets to move focus to its own UI.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return
  // Only a field being typed in (or an open dialog / the key sheet) keeps Tab for itself.
  if (e.target.closest?.('input,textarea,select,[contenteditable]') || pick || parking || $('#ovHelp').classList.contains('on')) return
  e.preventDefault()
  awaitingNew = false
  awaitingRole = false
  setView(nextView(view, e.shiftKey ? -1 : 1))
}, true)

document.addEventListener('keydown', (e) => {
  if (pick || parking || palette) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (renaming) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
    else if (e.key === 'Escape') { renaming = null; render() }
    return
  }
  if (awaitingNew) {
    awaitingNew = false
    $('#toast').classList.remove('on')
    const role = { i: 'interface', m: 'manager', w: 'worker', p: '', Enter: '' }[e.key]
    if (role !== undefined) { e.preventDefault(); newSession(role) }
    return
  }
  if (awaitingRole) {
    awaitingRole = false
    const role = { i: 'interface', m: 'manager', w: 'worker', x: '' }[e.key]
    if (role !== undefined) { e.preventDefault(); classifySel(role) }
    return
  }
  const help = $('#ovHelp')
  if (e.key === 'Escape') return help.classList.remove('on')
  if (e.key === '?') return toggleHelp()
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); openSel() }
  else if (e.key === 'a') { e.preventDefault(); openPick() }
  else if (e.key === 'P' && items().length) { e.preventDefault(); parkSel() }
  else if (e.key === 'd' && items().length) { e.preventDefault(); doneSel() }
  else if (e.key === 'u') { e.preventDefault(); unparkSel() }
  else if (e.key === 'z') { e.preventDefault(); undoLast() }
  else if (e.key === 'p') setView('parked')
  else if (e.key === '/' && view !== 'queue') { e.preventDefault(); $('#flt').focus() }
  else if (e.key === 'b') { e.preventDefault(); setRail(!railOpen) }
  else if (e.key === 'e') { e.preventDefault(); setTicker(!tickerOpen) }
  else if (e.key === 'v') { e.preventDefault(); toggleParkedShown() }
  else if (e.key === 'm' || e.key === 'w') { e.preventDefault(); toggleRoleKey(e.key) }
  else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); stepProject(e.key === 'g' ? 1 : -1) }
  else if (e.key === 'i') { e.preventDefault(); jumpToInterface() }
  else if (e.key === 't') setView('tree')
  else if (e.key === 'h' || e.key === 'q') setView('queue')
  else if (e.key === 'c') { e.preventDefault(); startClassify() }
  else if (e.key === 'C' && view === 'tree') { e.preventDefault(); classifyGroup() }
  else if (e.key === 'r' && items().length) { e.preventDefault(); startRename() }
  else if (e.key === 'n') { e.preventDefault(); startNew() }
})

document.querySelectorAll('.pill[data-view]').forEach((p) => p.addEventListener('click', () => setView(p.dataset.view)))
for (const el of [$('#list'), $('#side')]) {
  el.addEventListener('click', (e) => {
    const q = e.target.closest('.q')
    if (!q || e.target.tagName === 'INPUT') return
    sel = q.dataset.id
    if (e.target.closest('.bg')) openBg.has(sel) ? openBg.delete(sel) : openBg.add(sel)
    render()
  })
  el.addEventListener('dblclick', (e) => { if (e.target.closest('.q')) openSel() })
}
function toggleHelp() { $('#ovHelp').classList.toggle('on') }
$('#helpBtn').addEventListener('click', toggleHelp)
$('#ovHelp').addEventListener('click', (e) => { if (e.target.id === 'ovHelp') e.currentTarget.classList.remove('on') })

// Wait timers tick locally; the server only pushes when the queue changes.
setInterval(() => {
  const now = Date.now()
  document.querySelectorAll('.wt[data-since]').forEach((el) => {
    const since = Number(el.dataset.since)
    el.textContent = fmt(now - since)
    el.closest('.q').classList.toggle('od', !el.closest('.q').classList.contains('wk') && now - since > OVERDUE_MS)
  })
  updateAmbient(now)
  updateTelemetry(now)
}, 1000)

// Idle telemetry in the header: a clock and a five-minute needs-you sparkline. Change-only DOM writes.
let sparkSamples = []
let lastSampleAt = 0
let sparkKey = ''
function updateTelemetry(now) {
  const clock = clockText(now)
  const el = $('#clock')
  if (el.textContent !== clock) el.textContent = clock
  if (now - lastSampleAt >= 5000) {
    lastSampleAt = now
    sparkSamples = pushSample(sparkSamples, attention(queue, now, OVERDUE_MS).count)
    const pts = sparkPoints(sparkSamples, 64, 18)
    if (pts !== sparkKey) {
      sparkKey = pts
      $('#sparkLine').setAttribute('points', pts)
    }
  }
}

// Boot-up: the header stagger and the scan line run once; then the class comes off so nothing replays.
setTimeout(() => document.body.classList.remove('booting'), 1600)

/** Re-trigger a one-shot flicker on a readout whose value just changed. */
function flicker(el) {
  el.classList.remove('flick')
  void el.getBoundingClientRect() // restart the animation
  el.classList.add('flick')
}

const live = (ok) => { document.querySelector('#conn .live').classList.toggle('off', !ok) }
const es = new EventSource('/api/events')
const HOOK_LABEL = { live: 'events live', stale: 'stale', absent: 'absent' }
function setHook(h) {
  const el = $('#hookst')
  const st = HOOK_LABEL[h?.status] ? h.status : 'unknown'
  el.className = `mono hk ${st}`
  hookStatus = h?.status || ''
  dialKey = ''
  updateDials(Date.now())
  el.textContent = `hook: ${HOOK_LABEL[st] || 'unknown'}`
  el.title =
    st === 'absent' ? 'No hook markers on disk: the hook never ran, or every session has ended'
    : st === 'unknown' ? 'Hook status unknown'
    : `Last hook event ${fmt(Date.now() - h.lastAt)} ago`
}
es.onmessage = (m) => {
  const d = JSON.parse(m.data)
  live(true)
  setHook(d.hook)
  claims = Array.isArray(d.claims) ? d.claims : []
  pushPushed(d.events)
  setQueue(d.queue)
}
es.onerror = () => live(false)
render()
loadTree()
