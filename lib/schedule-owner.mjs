// The session a schedule is tied to (`npm run schedule add … --by <id>`): its name, role and whether it still exists,
// for the Schedule view, and a job list grouped by owner for the roster. Read-only joins over the desktop records.
import { classify } from './roles.mjs'
import { describeCron, nextRuns } from './cron.mjs'

const isArchived = (r) => r.isArchived === true || r.isArchived === 'True'
const short = (id) => String(id).slice(0, 8)

/**
 * { session, app, name, role, gone } for a job's owner, or null for an unowned job. `ctx` is { records, deleted, state, roles }.
 * `gone` is true when the app has no live record for it any more (deleted or archived). Name: overlay, else the app
 * title, else a short id. Without a ctx the owner is shown as known (not gone) under its short id.
 */
export function ownerInfo(owner, ctx) {
  if (!owner) return null
  const { session = '', app = '' } = owner
  if (!ctx) return { session, app, name: short(session || app), role: '', gone: false }
  const mine = ctx.records.filter((r) => (session && r.cliSessionId === session) || (app && r.sessionId === app))
  const live = mine.find((r) => !isArchived(r) && !ctx.deleted?.has(r.sessionId))
  const rec = live || mine[0]
  const id = session || rec?.cliSessionId || ''
  const node = id && live ? classify({ records: ctx.records, roles: ctx.roles || {} }).get(id) : null
  const name = (id && ctx.state?.overlays?.[id]?.name) || rec?.title || short(id || app)
  return { session: id, app: app || rec?.sessionId || '', name, role: node?.role || '', gone: !live }
}

/** Jobs grouped by the CLI session id of their owner: { [sessionId]: [{ name, cron, desc, note, next }] }. */
export function schedulesBySession(jobs, now = Date.now()) {
  const out = {}
  for (const j of jobs) {
    const id = j.owner?.session
    if (!id) continue
    ;(out[id] ||= []).push({ name: j.name, cron: j.cron, desc: describeCron(j.cron), note: j.note, next: nextRuns(j.cron, now, 1)[0] ?? null })
  }
  return out
}
