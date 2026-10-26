// Role classification: every session is the interface, a project manager, or a worker.
// The tree is logical (the tool's registry), not the app's spawn links; `spawnedFrom` is one input.
// Pure: takes desktop records and the registry, returns nodes. Invariants warn, never block.

export const ROLES = ['interface', 'manager', 'worker']
/** Registry value meaning "deliberately no role": beats a hook tag and spawn inference. */
export const NO_ROLE = 'none'

/** Whether `role` may start a new session: a real role, or empty for a plain one. */
export const isNewSessionRole = (role) => !role || ROLES.includes(role)

/** The tag a new session's first prompt carries; the hook reads it. Empty when `role` is not one. */
export function roleMarker(role, parent = '') {
  if (!ROLES.includes(role)) return ''
  return role === 'worker' && /^[A-Za-z0-9_-]{8,80}$/.test(parent) ? `[zarvis: role=worker parent=${parent}]` : `[zarvis: role=${role}]`
}

/** The skills the interface and manager sessions load; `npm run setup` installs them. */
export const INTERFACE_SKILL = 'zarvis-interface'
export const MANAGER_SKILL = 'zarvis-manager'

/**
 * A new session's whole first prompt: the role tag, plus for managers and the interface one line
 * saying where to learn the job. Built only from a validated role; the client never sends text.
 */
export function rolePrompt(role, parent = '', rosterFile = '~/.zarvis/roster.md') {
  const marker = roleMarker(role, parent)
  if (marker && role === 'manager') return `${marker} Your workers are listed in ${rosterFile}. Use the ${MANAGER_SKILL} skill (installed by npm run setup) for your role.`
  if (marker && role === 'interface') return `${marker} Use the ${INTERFACE_SKILL} skill (installed by npm run setup) for your role. The roster is ${rosterFile}.`
  return marker
}

const isArchived = (r) => r.isArchived === true || r.isArchived === 'True'

/**
 * Classify the live (non-archived) records.
 *   roles: { [cliSessionId]: { role, parent? } }   explicit tags, manual ones already merged over hook ones
 * Order per the spec: explicit tag, then spawned by a manager -> worker, then a session that has
 * spawned children is only *suggested* as a manager; the rest is unclassified.
 * Each node: { sessionId, desktopSessionId, title, cwd, role, source, suggested, managerId, warnings }
 * where `sessionId` is the CLI id (the key hooks, markers and overlays use).
 */
export function classify({ records, roles = {} }) {
  const live = records.filter((r) => r.cliSessionId && !isArchived(r))
  const byDesktop = new Map(live.map((r) => [r.sessionId, r]))
  const nodes = new Map()

  for (const r of live) {
    const tag = roles[r.cliSessionId]
    nodes.set(r.cliSessionId, {
      sessionId: r.cliSessionId,
      desktopSessionId: r.sessionId,
      title: r.title || 'Untitled session',
      cwd: r.cwd || '',
      role: ROLES.includes(tag?.role) ? tag.role : 'unclassified',
      source: ROLES.includes(tag?.role) ? 'tag' : tag?.role === NO_ROLE ? 'cleared' : 'none',
      suggested: '',
      managerId: ROLES.includes(tag?.role) && tag.parent && tag.parent !== r.cliSessionId ? tag.parent : '',
      warnings: [],
    })
  }

  // The app's spawn parent, ignoring the interface (rule 6: only manager -> worker is nesting).
  const spawnParent = (r) => {
    const p = byDesktop.get(r.spawnedFrom?.sessionId)
    const pn = p && nodes.get(p.cliSessionId)
    return pn && pn.role !== 'interface' ? pn : null
  }
  const spawnedChildren = new Map()
  for (const r of live) {
    const p = spawnParent(r)
    if (p) spawnedChildren.set(p.sessionId, (spawnedChildren.get(p.sessionId) || 0) + 1)
  }

  for (const r of live) {
    const n = nodes.get(r.cliSessionId)
    if (n.source === 'cleared') continue // `x`: no role, whatever the spawn links say
    if (n.role !== 'unclassified') {
      if (n.role === 'worker' && !n.managerId) {
        const p = spawnParent(r)
        if (p?.role === 'manager') n.managerId = p.sessionId
      }
      continue
    }
    const p = spawnParent(r)
    if (p?.role === 'manager') {
      Object.assign(n, { role: 'worker', source: 'spawn', managerId: p.sessionId })
    } else if (spawnedChildren.get(n.sessionId)) {
      n.suggested = 'manager'
    }
  }

  const interfaces = [...nodes.values()].filter((n) => n.role === 'interface')
  for (const n of nodes.values()) {
    if (n.role === 'interface' && interfaces.length > 1) n.warnings.push('more than one interface session')
    if (n.role === 'manager' && n.managerId) n.warnings.push('a manager has no manager')
    if (n.role === 'worker' && n.managerId && nodes.get(n.managerId)?.role !== 'manager') n.warnings.push('worker is attached to something that is not a manager')
    if (n.role === 'worker' && [...nodes.values()].some((c) => c.managerId === n.sessionId)) n.warnings.push('a worker has children')
  }
  return nodes
}

/** Workers directly under each manager: Map<managerId, node[]>. */
export function childrenOf(nodes) {
  const out = new Map()
  for (const n of nodes.values()) {
    if (n.role === 'worker' && n.managerId && nodes.has(n.managerId)) {
      if (!out.has(n.managerId)) out.set(n.managerId, [])
      out.get(n.managerId).push(n)
    }
  }
  return out
}
