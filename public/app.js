'use strict'
const $ = (s) => document.querySelector(s)
const OVERDUE_MS = 5 * 60 * 1000
let queue = []
let sel = null // sessionId of the selected row
let renaming = null // sessionId being renamed
let seen = new Set()
let first = true
let fresh = new Set()

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
}

function crumbs(r) {
  const parts = [r.project]
  if (r.initiative) parts.push(r.initiative)
  parts.push(r.branch || r.worktree || '—')
  return parts.map(esc).join(' › ')
}

function render() {
  $('#qb').textContent = queue.length || ''
  const list = $('#list')
  if (!queue.length) {
    list.innerHTML = '<div class="empty">Nothing waiting on you.</div>'
    return
  }
  if (!queue.some((r) => r.sessionId === sel)) sel = queue[0].sessionId
  const now = Date.now()
  list.innerHTML = queue
    .map((r) => {
      const od = now - r.since > OVERDUE_MS
      const name =
        renaming === r.sessionId
          ? `<input id="renIn" value="${esc(r.name)}" maxlength="120">`
          : `<span class="nm">${esc(r.name)}</span>` + (r.overlay ? `<span class="ap">app: ${esc(r.title)}</span>` : '')
      const cmd = r.command || r.tool ? `<div class="cmd mono"><span class="tool">${esc(r.tool)}</span>${esc(r.command)}</div>` : ''
      return (
        `<div class="q${od ? ' od' : ''}${r.sessionId === sel ? ' sel' : ''}${fresh.has(r.sessionId) ? ' arrive' : ''}" data-id="${esc(r.sessionId)}">` +
        `<div class="r1"><span class="key">${crumbs(r)}</span>${name}<span class="wt num" data-since="${r.since}">${fmt(now - r.since)}</span></div>` +
        `<div class="prompt">${esc(r.prompt)}${r.link ? '' : ' <span class="ap">(terminal session: cannot open from here)</span>'}</div>` +
        cmd +
        `<span class="go">ENTER ↵ OPEN</span></div>`
      )
    })
    .join('')
  if (renaming) {
    const inp = $('#renIn')
    if (inp && document.activeElement !== inp) {
      inp.focus()
      inp.select()
    }
  }
}

function setQueue(q) {
  queue = q
  // New arrivals draw the eye once; the very first load is not an arrival.
  fresh = new Set(first ? [] : q.filter((r) => !seen.has(r.sessionId)).map((r) => r.sessionId))
  seen = new Set(q.map((r) => r.sessionId))
  first = false
  if (renaming && !q.some((r) => r.sessionId === renaming)) renaming = null
  render()
}

function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toast.t)
  toast.t = setTimeout(() => t.classList.remove('on'), 2600)
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

async function openSel() {
  const r = queue.find((x) => x.sessionId === sel)
  if (!r) return
  const { ok, data } = await post('/api/open', { sessionId: r.sessionId })
  toast(ok ? `Opening “${r.name}” in Claude…${data.dryRun ? ' (dry run)' : ''}` : data.error || 'Open failed')
}

async function newSession() {
  const r = queue.find((x) => x.sessionId === sel)
  const { ok, data } = await post('/api/new', { sessionId: r?.sessionId })
  const where = data.folder ? ` in ${data.folder.split(/[\\/]/).pop()}` : ''
  toast(ok ? `Opening a new Claude Code session${where}…${data.dryRun ? ' (dry run)' : ''}` : data.error || 'New session failed')
}

async function commitRename() {
  const id = renaming
  const val = $('#renIn')?.value ?? ''
  renaming = null
  const r = queue.find((x) => x.sessionId === id)
  // Typing the app's own title back is the same as clearing the overlay.
  await post('/api/rename', { sessionId: id, name: r && val.trim() === r.title ? '' : val })
}

function move(d) {
  const i = queue.findIndex((r) => r.sessionId === sel)
  const n = Math.min(queue.length - 1, Math.max(0, i + d))
  if (queue[n]) sel = queue[n].sessionId
  render()
  document.querySelector('.q.sel')?.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (renaming) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
    else if (e.key === 'Escape') { renaming = null; render() }
    return
  }
  const help = $('#ovHelp')
  if (e.key === 'Escape') return help.classList.remove('on')
  if (e.key === '?') return help.classList.toggle('on')
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); openSel() }
  else if (e.key === 'r' && queue.length) { e.preventDefault(); renaming = sel; render() }
  else if (e.key === 'n') { e.preventDefault(); newSession() }
})

$('#list').addEventListener('click', (e) => {
  const q = e.target.closest('.q')
  if (!q || e.target.tagName === 'INPUT') return
  sel = q.dataset.id
  render()
})
$('#list').addEventListener('dblclick', (e) => { if (e.target.closest('.q')) openSel() })
$('#helpBtn').addEventListener('click', () => $('#ovHelp').classList.toggle('on'))
$('#ovHelp').addEventListener('click', (e) => { if (e.target.id === 'ovHelp') e.currentTarget.classList.remove('on') })

// Wait timers tick locally; the server only pushes when the queue changes.
setInterval(() => {
  const now = Date.now()
  document.querySelectorAll('.wt').forEach((el) => {
    const since = Number(el.dataset.since)
    el.textContent = fmt(now - since)
    el.closest('.q').classList.toggle('od', now - since > OVERDUE_MS)
  })
}, 1000)

const live = (ok) => { document.querySelector('#conn .live').classList.toggle('off', !ok) }
const es = new EventSource('/api/events')
es.onmessage = (m) => { live(true); setQueue(JSON.parse(m.data).queue) }
es.onerror = () => live(false)
render()
