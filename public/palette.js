'use strict'
// Command palette: pure logic only (scoring, command registry, filtering). The DOM and the actions live in app.js.

/**
 * Fuzzy-match one query token against a text: every character of the token must appear in order.
 * Returns { score, idx } (idx = matched character positions, for highlighting) or null.
 * Rewards a prefix, word starts and consecutive runs; a contiguous substring beats a scattered match.
 */
export function fuzzy(token, text) {
  const q = token.toLowerCase()
  const t = String(text ?? '').toLowerCase()
  if (!q) return { score: 0, idx: [] }
  if (!t) return null
  const at = t.indexOf(q)
  if (at >= 0) {
    const idx = Array.from({ length: q.length }, (_, i) => at + i)
    const wordStart = at === 0 || /[^a-z0-9]/.test(t[at - 1])
    return { score: 100 + q.length * 10 + (at === 0 ? 60 : wordStart ? 40 : 0) - Math.min(at, 30) - Math.min(t.length - q.length, 40) / 4, idx }
  }
  const idx = []
  let score = 0
  let run = 0
  let from = 0
  for (const ch of q) {
    const i = t.indexOf(ch, from)
    if (i < 0) return null
    const consecutive = idx.length && i === idx[idx.length - 1] + 1
    run = consecutive ? run + 1 : 0
    score += 8 + run * 6 + (i === 0 || /[^a-z0-9]/.test(t[i - 1]) ? 14 : 0) - Math.min(i - from, 6)
    idx.push(i)
    from = i + 1
  }
  return { score, idx }
}

const tokens = (q) => q.trim().split(/\s+/).filter(Boolean)

/** `>` commands only, `@` sessions only; anything else searches both. */
export function parseMode(raw) {
  const s = String(raw ?? '')
  if (s.startsWith('>')) return { mode: 'commands', text: s.slice(1) }
  if (s.startsWith('@')) return { mode: 'sessions', text: s.slice(1) }
  return { mode: 'all', text: s }
}

const SESSION_FIELDS = (r, stateLabel) => [
  [r.name, 1],
  [r.title && r.title !== r.name ? r.title : '', 0.8],
  [r.project, 0.7],
  [r.branch || r.worktree, 0.7],
  [r.role, 0.6],
  [stateLabel, 0.6],
  // a parked session is found by why it was parked and by its handoff note, so it can be brought back
  [r.parked?.reason, 0.7],
  [r.parked?.handoffNote, 0.5],
  [r.parked?.parkedByName, 0.4],
]

/** Score a session row against the query: every token must hit some field. Returns { score, idx } (idx into the name) or null. */
export function scoreSession(q, r, stateLabel = r.state) {
  const ts = tokens(q)
  if (!ts.length) return { score: 0, idx: [] }
  const fields = SESSION_FIELDS(r, stateLabel)
  let score = 0
  for (const t of ts) {
    let best = null
    for (const [text, w] of fields) {
      const m = text && fuzzy(t, text)
      if (m && (!best || m.score * w > best)) best = m.score * w
    }
    if (best === null) return null
    score += best
  }
  const nm = fuzzy(ts.join(' '), r.name)
  return { score, idx: nm ? nm.idx : [] }
}

export function scoreCommand(q, c) {
  const ts = tokens(q)
  if (!ts.length) return { score: 0, idx: [] }
  let score = 0
  for (const t of ts) {
    const m = fuzzy(t, c.label)
    const g = fuzzy(t, `${c.group} ${c.label} ${c.words || ''}`)
    const best = m ? m.score : g ? g.score * 0.7 : null
    if (best === null) return null
    score += best
  }
  const nm = fuzzy(ts.join(' '), c.label)
  return { score, idx: nm ? nm.idx : [] }
}

/**
 * Every existing key action, one entry per way to run it. `key` is the hint shown beside it.
 * app.js maps each id to the same function the key handler calls (a test keeps the two in step).
 */
export const COMMANDS = [
  { id: 'view-queue', group: 'View', label: 'Attention queue', key: 'h', words: 'q home' },
  { id: 'view-tree', group: 'View', label: 'Role tree', key: 't', words: 'roles' },
  { id: 'view-parked', group: 'View', label: 'Parked view', key: 'p' },
  { id: 'view-next', group: 'View', label: 'Next view', key: 'Tab', words: 'cycle' },
  { id: 'view-prev', group: 'View', label: 'Previous view', key: 'Shift+Tab', words: 'cycle back' },
  { id: 'search', group: 'View', label: 'Search Roles or Parked', key: '/', words: 'find filter' },
  { id: 'project-next', group: 'Filter', label: 'Next project filter', key: 'g' },
  { id: 'project-prev', group: 'Filter', label: 'Previous project filter', key: 'G' },
  { id: 'project-all', group: 'Filter', label: 'Project: All', key: '', words: 'clear' },
  { id: 'role-manager', group: 'Filter', label: 'Queue: managers only', key: 'm', words: 'role filter' },
  { id: 'role-worker', group: 'Filter', label: 'Queue: workers only', key: 'w', words: 'role filter' },
  { id: 'toggle-parked', group: 'Filter', label: 'Roles: show or hide parked', key: 'v' },
  { id: 'open', group: 'Session', label: 'Open selected in Claude', key: 'Enter' },
  { id: 'interface', group: 'Session', label: 'Jump to the interface session', key: 'i' },
  { id: 'rename', group: 'Session', label: 'Rename selected', key: 'r' },
  { id: 'park', group: 'Session', label: 'Park selected (unparks if parked)', key: 'P' },
  { id: 'unpark', group: 'Session', label: 'Unpark selected', key: 'u' },
  { id: 'done', group: 'Session', label: 'Mark selected done (or bring it back)', key: 'd' },
  { id: 'undo', group: 'Session', label: 'Undo last park, unpark or done', key: 'z' },
  { id: 'attach', group: 'Session', label: 'Attach workers to selected manager', key: 'a' },
  { id: 'new-interface', group: 'New', label: 'New session: interface', key: 'n i' },
  { id: 'new-manager', group: 'New', label: 'New session: manager', key: 'n m' },
  { id: 'new-worker', group: 'New', label: 'New session: worker', key: 'n w' },
  { id: 'new-plain', group: 'New', label: 'New session: plain', key: 'n p' },
  { id: 'classify-interface', group: 'Classify', label: 'Classify selected: interface', key: 'c i' },
  { id: 'classify-manager', group: 'Classify', label: 'Classify selected: manager', key: 'c m' },
  { id: 'classify-worker', group: 'Classify', label: 'Classify selected: worker', key: 'c w' },
  { id: 'classify-clear', group: 'Classify', label: 'Classify selected: clear', key: 'c x' },
  { id: 'classify-group', group: 'Classify', label: 'Roles: make every unclassified a worker', key: 'C' },
  { id: 'rail', group: 'Screen', label: 'Toggle project rail', key: 'b' },
  { id: 'ticker', group: 'Screen', label: 'Toggle event ticker', key: 'e' },
  { id: 'help', group: 'Screen', label: 'Key sheet', key: '?', words: 'help keys' },
]

/** The registry plus one "Project: X" command per project chip. */
export function buildCommands(projects = []) {
  const hasAll = (c) => c.id !== 'project-all' || projects.length > 0
  return [...COMMANDS.filter(hasAll), ...projects.map((p) => ({ id: `project:${p}`, group: 'Filter', label: `Project: ${p}`, key: '', words: 'filter' }))]
}

/**
 * The palette's result list. `sessions` are rows ({ sessionId, name, project, … }); `commands` from buildCommands.
 * Entries are { key, type, label, idx, score, ref }; `key` is stable across live updates ('s:<id>' / 'c:<id>').
 * No query: sessions in the given order, then commands.
 */
export function search(raw, sessions, commands, { stateLabel = (r) => r.state, limit = 60 } = {}) {
  const { mode, text } = parseMode(raw)
  const out = []
  if (mode !== 'commands') {
    sessions.forEach((r, i) => {
      const m = scoreSession(text, r, stateLabel(r))
      if (m) out.push({ key: `s:${r.sessionId}`, type: 'session', label: r.name, idx: m.idx, score: m.score + 0.5, order: i, ref: r })
    })
  }
  if (mode !== 'sessions') {
    commands.forEach((c, i) => {
      const m = scoreCommand(text, c)
      if (m) out.push({ key: `c:${c.id}`, type: 'command', label: c.label, idx: m.idx, score: m.score, order: 1e6 + i, ref: c })
    })
  }
  const empty = !text.trim()
  out.sort((a, b) => (empty ? a.order - b.order : b.score - a.score || a.order - b.order))
  return out.slice(0, limit)
}

/** Keep the highlight on the same entry across a live update; otherwise clamp to the list. */
export function keepHighlight(entries, key, idx = 0) {
  if (!entries.length) return { key: '', idx: 0 }
  const at = entries.findIndex((e) => e.key === key)
  const i = at >= 0 ? at : Math.min(Math.max(idx, 0), entries.length - 1)
  return { key: entries[i].key, idx: i }
}

/** Step the highlight, stopping at the ends. */
export function stepHighlight(entries, idx, d) {
  return entries.length ? Math.min(entries.length - 1, Math.max(0, idx + d)) : 0
}
