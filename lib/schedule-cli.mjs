// The schedule CLI's logic. Writes only ~/.zarvis/schedules.json, so it works with the server stopped.
//
//   add <name> --cron "0 * * * *" | --every 30m|1h|1d | --at "09:00,13:00" [--note "..."] [--link <url or file path>] [--by <session id>]
//   set <name> [--cron ... | --every ... | --at ...] [--note "..."] [--link <url or file>|none] [--by <session id>|none]
//   list [--json]
//   remove <name>
//   next <name> [--count 5]
import { zarvisHome } from './claims.mjs'
import { describeCron, nextRuns } from './cron.mjs'
import { addJob, setJob, readJobs, removeJob, MAX_JOBS } from './schedule.mjs'
import { resolveBy } from './events-cli.mjs'
import { scanDesktopRecords } from './sessions.mjs'

const USAGE = 'usage: npm run schedule -- add <name> (--cron "0 * * * *" | --every 30m|1h|1d | --at "09:00,13:00") [--note "..."] [--link <url or file>] [--by <session id>] | set <name> [--cron ... | --every ... | --at ...] [--note "..."] [--link <url or file>|none] [--by <session id>|none] | list [--json] | remove <name> | next <name> [--count 5]'
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = { '--cron': 'cron', '--every': 'every', '--at': 'at', '--note': 'note', '--link': 'link', '--count': 'count', '--by': 'by' }

export function parseArgs(argv) {
  const out = { cmd: argv[0] || '', arg: '', cron: '', every: '', at: '', note: '', link: '', count: '', by: '', json: false, has: new Set() }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (FLAGS[a]) {
      if (i + 1 >= rest.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = rest[++i]
      out.has.add(FLAGS[a])
    } else if (a === '--json') out.json = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else if (!out.arg) out.arg = a
    else throw refuse(`unexpected argument ${a} (quote a name that has spaces)`)
  }
  return out
}

/** `30m`, `2h`, `1d` as a cron spec. Only intervals that divide evenly are exact in cron, so others are refused. */
export function everyToCron(text) {
  const m = /^(\d{1,3})\s*([mhd])$/i.exec(String(text).trim())
  if (!m || Number(m[1]) < 1) throw refuse(`--every takes 30m, 2h or 1d, not "${text}"`)
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  if (unit === 'm' && n < 60 && 60 % n === 0) return n === 1 ? '* * * * *' : `*/${n} * * * *`
  if (unit === 'm' && n % 60 === 0) return everyToCron(`${n / 60}h`)
  if (unit === 'h' && n < 24 && 24 % n === 0) return n === 1 ? '0 * * * *' : `0 */${n} * * *`
  if (unit === 'h' && n % 24 === 0) return everyToCron(`${n / 24}d`)
  if (unit === 'd' && n === 1) return '0 0 * * *'
  throw refuse(`--every ${text} does not fit a cron schedule evenly: use --cron or --at`)
}

/** "09:00,13:00" as a cron spec. All times must share the same minute (cron has one minute field). */
export function atToCron(text) {
  const times = String(text).split(',').map((t) => /^(\d{1,2}):(\d{2})$/.exec(t.trim()))
  if (!times.length || times.some((m) => !m || Number(m[1]) > 23 || Number(m[2]) > 59)) throw refuse(`--at takes times like "09:00,13:00", not "${text}"`)
  if (new Set(times.map((m) => Number(m[2]))).size > 1) throw refuse('--at times must share the same minute (09:00,13:00): add one schedule per different minute, or use --cron')
  return `${Number(times[0][2])} ${[...new Set(times.map((m) => Number(m[1])))].sort((a, b) => a - b).join(',')} * * *`
}

/**
 * `--by` as an owner { session, app }: the CLI session id (via resolveBy, so the app's local_ id works too) and the app
 * id when a desktop record for it exists. An id that matches no record is still accepted as a CLI id, with no app id.
 */
export async function resolveOwner(by, deps) {
  const session = await resolveBy(by, deps)
  const records = deps?.records || (await scanDesktopRecords()).records
  const mine = records.filter((r) => r.cliSessionId === session && r.sessionId)
  const rec = mine.find((r) => !(r.isArchived === true || r.isArchived === 'True')) || mine[0]
  return { session, app: rec?.sessionId || '' }
}

const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Run one command. Returns the exit code. */
export async function runSchedule(argv, { home = zarvisHome(), cwd = process.cwd(), now = Date.now(), deps, log = console.log, err = console.error } = {}) {
  let usage = false
  try {
    const a = parseArgs(argv)
    if (!['add', 'set', 'list', 'remove', 'next'].includes(a.cmd)) {
      usage = true
      throw refuse(a.cmd ? `unknown command ${a.cmd}` : 'no command given')
    }
    if (a.cmd === 'list') {
      const jobs = await readJobs(home)
      if (a.json) log(JSON.stringify({ jobs: jobs.map((j) => ({ ...j, description: describeCron(j.cron), next: nextRuns(j.cron, now, 1)[0] || null })) }, null, 2))
      else if (!jobs.length) log('no schedules')
      else for (const j of jobs) log(`${j.name} — ${j.cron} (${describeCron(j.cron)})${j.note ? ` — ${j.note}` : ''}${j.link ? ` — ${j.link}` : ''}${j.owner ? ` — session ${j.owner.session || j.owner.app}` : ''}`)
      return 0
    }
    if (!a.arg) {
      usage = true
      throw refuse(`${a.cmd} needs a job name`)
    }
    if (a.cmd === 'remove') {
      const gone = await removeJob(home, a.arg)
      if (!gone) throw refuse(`no schedule named ${a.arg}`)
      log(`removed ${gone.name}`)
      return 0
    }
    if (a.cmd === 'next') {
      const job = (await readJobs(home)).find((j) => j.name.toLowerCase() === a.arg.toLowerCase())
      if (!job) throw refuse(`no schedule named ${a.arg}`)
      const n = a.count === '' ? 5 : Number(a.count)
      if (!Number.isInteger(n) || n < 1 || n > 100) throw refuse('--count takes 1-100')
      const runs = nextRuns(job.cron, now, n)
      if (!runs.length) log(`${job.name}: never runs (${job.cron})`)
      else runs.forEach((t) => log(when(t)))
      return 0
    }
    const given = [a.cron, a.every, a.at].filter(Boolean)
    const owner = a.by && !(a.cmd === 'set' && a.by === 'none') ? await resolveOwner(a.by, deps) : null
    if (a.cmd === 'set') {
      if (given.length > 1) throw refuse('give at most one of --cron, --every, --at')
      if (!a.has.size) throw refuse('set needs something to change: --cron, --every, --at, --note, --link or --by')
      const patch = {}
      if (given.length) patch.cron = a.cron || (a.every ? everyToCron(a.every) : atToCron(a.at))
      if (a.has.has('note')) patch.note = a.note
      if (a.has.has('link')) patch.link = a.link === 'none' ? '' : a.link
      if (a.has.has('by')) patch.owner = owner
      const job = await setJob(home, a.arg, patch, { cwd })
      if (!job) throw refuse(`no schedule named ${a.arg}`)
      log(`updated ${job.name} — ${job.cron} (${describeCron(job.cron)})${job.owner ? ` — owner ${job.owner.session}` : ''}`)
      return 0
    }
    if (given.length !== 1) {
      usage = true
      throw refuse('give exactly one of --cron, --every, --at')
    }
    const cron = a.cron || (a.every ? everyToCron(a.every) : atToCron(a.at))
    const job = await addJob(home, { name: a.arg, cron, note: a.note, link: a.link, owner }, { now, cwd })
    const first = nextRuns(job.cron, now, 1)[0]
    log(`scheduled ${job.name} — ${job.cron} (${describeCron(job.cron)})${job.owner ? ` for session ${job.owner.session}` : ''}${first ? `; next ${when(first)}` : '; this never runs'} (up to ${MAX_JOBS} schedules)`)
    return 0
  } catch (e) {
    err(`schedule: ${e.message}`)
    if (usage) err(USAGE)
    return e.refusal ? 1 : 2
  }
}
