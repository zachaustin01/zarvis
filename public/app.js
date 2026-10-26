'use strict'
import { projectsOf, filterRows, hiddenBlocked, filterTreeByProject, cycleProject, projectHue } from '/projects.js'
const $ = (s) => document.querySelector(s)
const OVERDUE_MS = 5 * 60 * 1000
let queue = []
let view = 'queue' // 'queue' | 'tree' | 'parked'
let tree = { interface: [], managers: [], orphans: [], unclassified: [] }
let rawTree = null // the server's tree, done sessions included
let nodes = [] // the tree flattened in display order, for j/k
let parkedList = [] // parked sessions, newest first: the Parked view
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
try { project = localStorage.getItem('zarvis.project') || '' } catch { /* storage blocked */ }

const ICON = { interface: '◆', manager: '▣', worker: '●', unclassified: '?' }
const STATE_LABEL = { blocked: 'needs you', waiting_on_child: 'waiting on worker', working: 'working', idle: 'idle', unknown: 'no signal' }
// Project filter. A remembered project with no sessions left counts as All; the interface is never filtered out.
const projectList = () => projectsOf(queue, rawTree ? flatten(rawTree).map((n) => n.project) : [])
const activeProject = () => (projectList().some((p) => p.project === project) ? project : '')
const visibleQueue = () => filterRows(queue, activeProject())
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

function crumbs(r) {
  const parts = [r.project ? `<span class="pj" style="color:hsl(${projectHue(r.project)} 65% 68%)">${esc(r.project)}</span>` : '']
  if (r.initiative) parts.push(esc(r.initiative))
  const where = r.branch || r.worktree
  parts.push(esc(where || 'no branch'))
  return parts.join(' › ')
}

const heading = (text) => `<div class="hd sec">${text}</div>`
const SECTION = { working: 'Working', idle: 'Idle', blocked: 'Needs you', parked_blocked: 'Blocked, parked', waiting_on_child: 'Waiting on a worker' }
// Parked-but-blocked sessions are still shown, but apart from "Needs you" so that section and the badge agree.
const sectionOf = (r) => (r.state === 'blocked' && r.parked ? 'parked_blocked' : r.state)
const SECTION_RANK = { blocked: 0, parked_blocked: 1, waiting_on_child: 2, working: 3, idle: 4 }

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

/** Tree status text: the real state first, so a parked-but-blocked session still says it needs you. */
function treeStatus(r) {
  if (r.done) return 'done · d to undo'
  const real = STATE_LABEL[r.state] || r.state
  if (!r.parked) return real
  return r.state === 'unknown' ? 'parked · p to unpark' : `${real} · parked · p to unpark`
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
    `<div class="r1"><span class="ri" title="${esc(r.role)}">${ICON[r.role]}</span>${lifeTag(r)}<span class="key${r.branch || r.worktree ? '' : ' nb'}">${crumbs(r)}</span>${name}${warn(r)}${hint}${roll}` +
    `<span class="wt">${esc(treeStatus(r))}</span></div><span class="go">ENTER ↵ OPEN</span></div>`
  )
}

function renderTree() {
  renderBar()
  $('#side').innerHTML = ''
  document.querySelector('.wrap').classList.remove('has-side')
  const t = tree
  const part = (title, rows) => (rows.length ? heading(title) + rows.map((r) => treeRow(r, 0)).join('') : '')
  const mgr = t.managers.map((m) => treeRow(m, 0) + m.children.map((c) => treeRow(c, 1)).join('')).join('')
  $('#list').innerHTML =
    part('Interface', t.interface) + (mgr ? heading('Project managers') + mgr : '') + part('Workers without a manager', t.orphans) + part('Unclassified', t.unclassified) ||
    '<div class="empty">No sessions.</div>'
  if (!nodes.some((r) => r.sessionId === sel) && nodes.length) sel = nodes[0].sessionId
  if (renaming) {
    const inp = $('#renIn')
    if (inp && document.activeElement !== inp) {
      inp.focus()
      inp.select()
    }
  }
}

const when = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** The Parked view: every parked session with its reason, who parked it, when, and its handoff note. */
function renderParked() {
  $('#side').innerHTML = ''
  document.querySelector('.wrap').classList.remove('has-side')
  $('#list').innerHTML =
    parkedList
      .map((r) => {
        const p = r.parked
        const wake = r.wakeReady ? ' · <span class="wr">wake ready</span>' : p.wake ? ` · wakes ${esc(p.wake.value)}` : ''
        const by = p.parkedBy ? `by ${esc(p.parkedByName || p.parkedBy)}` : 'by hand'
        return (
          `<div class="q tr pkv${r.sessionId === sel ? ' sel' : ''}" data-id="${esc(r.sessionId)}">` +
          `<div class="r1"><span class="ri" title="${esc(r.role)}">${ICON[r.role]}</span><span class="pd">○</span><span class="key${r.branch || r.worktree ? '' : ' nb'}">${crumbs(r)}</span><span class="nm">${esc(r.name)}</span>` +
          `<span class="wt">parked ${esc(when(p.parkedAt))}</span></div>` +
          `<div class="prompt">${esc(p.reason)} · ${by}${wake}</div>` +
          (p.handoffNote ? `<div class="note">${esc(p.handoffNote)}</div>` : '') +
          `<span class="go">ENTER ↵ OPEN · u UNPARK</span></div>`
        )
      })
      .join('') || '<div class="empty">Nothing parked.</div>'
  if (!parkedList.some((r) => r.sessionId === sel) && parkedList.length) sel = parkedList[0].sessionId
}

/** Re-filter the server's tree for the current search and draw whichever tree-backed view is open. */
function applyTree() {
  tree = viewTree()
  nodes = flatten(tree)
  parkedList = nodes.filter((n) => n.parked && !n.done).sort((a, b) => b.parked.parkedAt - a.parked.parkedAt)
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

async function loadTree() {
  if (view === 'queue' || renaming) return
  try {
    rawTree = await (await fetch('/api/tree')).json()
    applyTree()
  } catch {
    /* next poll */
  }
}
setInterval(loadTree, 2000)

function rowHtml(r, now) {
  const working = r.state === 'working'
  const idle = r.state === 'idle'
  const od = r.state === 'blocked' && now - r.since > OVERDUE_MS
  const name =
    renaming === r.sessionId
      ? `<input id="renIn" value="${esc(r.name)}" maxlength="120">`
      : `<span class="nm">${esc(r.name)}</span>` + (r.overlay ? `<span class="ap">app: ${esc(r.title)}</span>` : '')
  const cmd = r.command || r.tool ? `<div class="cmd mono"><span class="tool">${esc(r.tool)}</span>${esc(r.command)}</div>` : ''
  return (
    `<div class="q${r.parked ? ' pkd' : ''}${working || r.state === 'waiting_on_child' ? ' wk' : ''}${idle ? ' wk id' : ''}${od ? ' od' : ''}${r.sessionId === sel ? ' sel' : ''}${fresh.has(r.sessionId) ? ' arrive' : ''}" data-id="${esc(r.sessionId)}">` +
    `<div class="r1"><span class="ri" title="${esc(r.role || '')}">${ICON[r.role] || ''}</span><span class="role ${esc(r.role || '')}">${esc(r.role || '')}</span><span class="key${r.branch || r.worktree ? '' : ' nb'}">${crumbs(r)}</span>${lifeTag(r)}${name}${warn(r)}<span class="wt num" data-since="${r.since}">${fmt(now - r.since)}</span></div>` +
    `<div class="prompt">${r.state === 'waiting_on_child' ? esc(r.prompt) + ' · Enter jumps to it' : working ? 'Working…' : idle ? 'Idle — waiting for your next prompt' : esc(r.prompt)}${r.link ? '' : ' <span class="ap">(terminal session: cannot open from here)</span>'}</div>` +
    cmd +
    `<span class="go">ENTER ↵ OPEN</span></div>`
  )
}

function setProject(p) {
  project = p
  try { localStorage.setItem('zarvis.project', p) } catch { /* storage blocked */ }
  if (view !== 'queue' && rawTree) applyTree()
  render()
}

/** The project filter bar: All plus one chip per project (needs-you and working counts), shown with 2+ projects. */
function renderBar() {
  const bar = $('#projbar')
  const list = projectList()
  const cur = activeProject()
  if (list.length < 2) { bar.hidden = true; bar.innerHTML = ''; return }
  bar.hidden = false
  const counts = (e) => `${e.blocked ? `<b class="nd">${e.blocked}</b>` : ''}${e.working ? `<b class="rn">${e.working}</b>` : ''}`
  const all = list.reduce((a, e) => ({ blocked: a.blocked + e.blocked, working: a.working + e.working }), { blocked: 0, working: 0 })
  const hidden = hiddenBlocked(queue, cur)
  bar.innerHTML =
    `<span class="chip${cur ? '' : ' on'}" data-p="">All ${counts(all)}</span>` +
    list.map((e) => `<span class="chip${e.project === cur ? ' on' : ''}" data-p="${esc(e.project)}" style="--ph:${projectHue(e.project)}">${esc(e.project)} ${counts(e)}</span>`).join('') +
    (hidden ? `<span class="chip hid" data-p="" title="Show all projects">${hidden} blocked in other projects</span>` : '') +
    '<span class="ap g">g cycle</span>'
}
$('#projbar').addEventListener('click', (e) => {
  const c = e.target.closest('.chip')
  if (c) setProject(c.dataset.p)
})

function render() {
  renderBar()
  if (view === 'tree') return renderTree()
  if (view === 'parked') return renderParked()
  const vq = visibleQueue()
  $('#qb').textContent = vq.filter((r) => r.state === 'blocked' && !r.parked).length || '' // what the "Needs you" section holds
  const list = $('#list')
  const side = $('#side')
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
  side.innerHTML = iface.length ? heading('Interface') + iface.map((r) => rowHtml(r, now)).join('') : ''
  let last = ''
  list.innerHTML =
    rest
      .map((r) => {
        const head = sectionOf(r) !== last ? heading(SECTION[sectionOf(r)]) : ''
        last = sectionOf(r)
        return head + rowHtml(r, now)
      })
      .join('') || (iface.length ? '<div class="empty">Nothing else waiting on you.</div>' : '')
  if (renaming) {
    const inp = $('#renIn')
    if (inp && document.activeElement !== inp) {
      inp.focus()
      inp.select()
    }
  }
}

function setQueue(q) {
  queue = [...q].sort((a, b) => (SECTION_RANK[sectionOf(a)] ?? 9) - (SECTION_RANK[sectionOf(b)] ?? 9)) // stable: the server's order within a section
  // New arrivals draw the eye once; the very first load is not an arrival.
  fresh = new Set(first ? [] : q.filter((r) => !seen.has(r.sessionId)).map((r) => r.sessionId))
  seen = new Set(q.map((r) => r.sessionId))
  first = false
  if (renaming && !q.some((r) => r.sessionId === renaming)) renaming = null
  render()
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
  if (!r.parked) return toast('Not parked (p parks it)')
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

document.addEventListener('keydown', (e) => {
  if (pick || parking) return
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
  if (e.key === '?') return help.classList.toggle('on')
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); openSel() }
  else if (e.key === 'a') { e.preventDefault(); openPick() }
  else if (e.key === 'p' && items().length) { e.preventDefault(); parkSel() }
  else if (e.key === 'd' && items().length) { e.preventDefault(); doneSel() }
  else if (e.key === 'u') { e.preventDefault(); unparkSel() }
  else if (e.key === 'z') { e.preventDefault(); undoLast() }
  else if (e.key === 'P') setView('parked')
  else if (e.key === '/' && view !== 'queue') { e.preventDefault(); $('#flt').focus() }
  else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setProject(cycleProject(projectList().map((p) => p.project), activeProject(), e.key === 'g' ? 1 : -1)) }
  else if (e.key === 'i') { e.preventDefault(); jumpToInterface() }
  else if (e.key === 't') setView('tree')
  else if (e.key === 'h' || e.key === 'q') setView('queue')
  else if (e.key === 'c') { e.preventDefault(); awaitingRole = true; toast('Classify: i interface · m manager · w worker · x clear') }
  else if (e.key === 'C' && view === 'tree') { e.preventDefault(); classifyGroup() }
  else if (e.key === 'r' && items().length) { e.preventDefault(); renaming = sel; render() }
  else if (e.key === 'n') { e.preventDefault(); awaitingNew = true; toast('New session as: i interface · m manager · w worker · p plain · Esc cancels', 60000) }
})

document.querySelectorAll('.pill[data-view]').forEach((p) => p.addEventListener('click', () => setView(p.dataset.view)))
for (const el of [$('#list'), $('#side')]) {
  el.addEventListener('click', (e) => {
    const q = e.target.closest('.q')
    if (!q || e.target.tagName === 'INPUT') return
    sel = q.dataset.id
    render()
  })
  el.addEventListener('dblclick', (e) => { if (e.target.closest('.q')) openSel() })
}
$('#helpBtn').addEventListener('click', () => $('#ovHelp').classList.toggle('on'))
$('#ovHelp').addEventListener('click', (e) => { if (e.target.id === 'ovHelp') e.currentTarget.classList.remove('on') })

// Wait timers tick locally; the server only pushes when the queue changes.
setInterval(() => {
  const now = Date.now()
  document.querySelectorAll('.wt[data-since]').forEach((el) => {
    const since = Number(el.dataset.since)
    el.textContent = fmt(now - since)
    el.closest('.q').classList.toggle('od', !el.closest('.q').classList.contains('wk') && now - since > OVERDUE_MS)
  })
}, 1000)

const live = (ok) => { document.querySelector('#conn .live').classList.toggle('off', !ok) }
const es = new EventSource('/api/events')
const HOOK_LABEL = { live: 'events live', stale: 'stale', absent: 'absent' }
function setHook(h) {
  const el = $('#hookst')
  const st = HOOK_LABEL[h?.status] ? h.status : 'unknown'
  el.className = `mono hk ${st}`
  el.textContent = `hook: ${HOOK_LABEL[st] || 'unknown'}`
  el.title =
    st === 'absent' ? 'No hook markers on disk: the hook never ran, or every session has ended'
    : st === 'unknown' ? 'Hook status unknown'
    : `Last hook event ${fmt(Date.now() - h.lastAt)} ago`
}
es.onmessage = (m) => { const d = JSON.parse(m.data); live(true); setHook(d.hook); setQueue(d.queue) }
es.onerror = () => live(false)
render()
