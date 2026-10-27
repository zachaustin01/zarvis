// Read-only importers: jobs that something other than `npm run schedule` already knows about, shown with
// `source: 'claude'` (or another tag) and never written back.
//
// Investigated on a Mac with the Claude desktop app: ~/.claude/jobs/<id>/ holds *background session* state
// (state.json, timeline.jsonl), not schedules; ~/.claude/daemon holds a control key and attach journals (off limits);
// the app support directory has no scheduled-task file. There is no stable, readable, documented source with a cron
// and a name, so nothing is imported yet and no format is guessed. To add one, write an async function returning
// [{ name, cron, note?, link? }] (validated by parseJob) and list it in IMPORTERS.
import { parseJob } from './schedule.mjs'

const IMPORTERS = []

/** Imported jobs from every importer, validated, tagged `source: 'claude'`. A failing importer is skipped. */
export async function importSchedules(importers = IMPORTERS) {
  const out = []
  for (const run of importers) {
    try {
      for (const raw of await run()) {
        const j = parseJob({ ...raw, source: 'claude' })
        if (j) out.push(j)
      }
    } catch { /* best effort */ }
  }
  return out
}
