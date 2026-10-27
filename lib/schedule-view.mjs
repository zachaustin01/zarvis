// What GET /api/schedule returns: every job (stored and imported) with its upcoming run times, computed here so
// the browser never parses cron. Future runs only.
import { describeCron, nextRuns } from './cron.mjs'
import { readJobs, MAX_JOBS } from './schedule.mjs'
import { importSchedules } from './schedule-import.mjs'
import { ownerInfo } from './schedule-owner.mjs'

export const HOUR = 3600000
/** The zoom windows the view offers (ms); a request is snapped up to the next one. */
export const SPANS = [3 * HOUR, 12 * HOUR, 24 * HOUR, 7 * 24 * HOUR]
/** Run times returned per job; a job with more in the window is flagged `dense`. */
export const MAX_RUNS = 300
/** How far to look for the single "next run" shown as a countdown. */
export const NEXT_HORIZON = 400 * 24 * HOUR
/** The track extends this much past the window and starts this much before now (see public/schedule.js). */
export const TRACK_AHEAD = 1.15

export const snapSpan = (n) => SPANS.find((s) => s >= n) || SPANS[SPANS.length - 1]

/**
 * `light` leaves the run lists out (the palette and the session cards only need `next`). `ctx` is the desktop records
 * ({ records, deleted, state, roles }) used to name each job's owner session.
 */
export async function scheduleView(home, { span, now = Date.now(), light = false, ctx } = {}) {
  const win = snapSpan(Number.isFinite(span) ? span : SPANS[1])
  const end = now + Math.round(win * TRACK_AHEAD)
  const jobs = [...(await readJobs(home)), ...(await importSchedules())].slice(0, MAX_JOBS)
  return {
    now,
    span: win,
    jobs: jobs.map((j) => {
      const runs = light ? [] : nextRuns(j.cron, now, MAX_RUNS + 1, end)
      const dense = runs.length > MAX_RUNS
      if (dense) runs.length = MAX_RUNS
      const next = runs[0] ?? nextRuns(j.cron, now, 1, now + NEXT_HORIZON)[0] ?? null
      return { name: j.name, cron: j.cron, desc: describeCron(j.cron), note: j.note, link: j.link, source: j.source, owner: ownerInfo(j.owner, ctx), next, runs, dense }
    }),
  }
}
