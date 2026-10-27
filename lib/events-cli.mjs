// The event CLI's logic: push one line into the ticker (~/.zarvis/events.jsonl), or switch the automatic
// git-push / PR events on and off.
//
//   event "<text>" [--kind push|info|done|warn|<word>] [--url <https://…>] [--by <sessionId>] [--dry-run]
//   event --auto on|off|status
//
// It must not break an agent: a bad argument exits 1 with one line, but trouble writing the file exits 0 with a
// stderr line (the event is only a log).
import { SAFE_ID, zarvisHome } from './claims.mjs'
import { DESKTOP_ID, scanDesktopRecords } from './sessions.mjs'
import { classify } from './roles.mjs'
import { find } from './park-cli.mjs'
import { buildEvent, appendEvent, autoEventsEnabled } from './events.mjs'
import { withState } from './state.mjs'
import path from 'node:path'

const USAGE = 'usage: npm run event -- "<text>" [--kind push|info|done|warn|<word>] [--url <https://…>] [--by <session id>] [--dry-run] | --auto on|off|status'

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = { '--kind': 'kind', '--url': 'url', '--by': 'by', '--auto': 'auto' }

export function parseArgs(argv) {
  const out = { text: '', kind: '', url: '', by: '', auto: '', dryRun: false }
  const words = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (FLAGS[a]) {
      if (i + 1 >= argv.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = argv[++i]
    } else if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else words.push(a)
  }
  out.text = words.join(' ')
  return out
}

/** The CLI session id for `--by`: a plain id as given, the app's `local_…` id looked up in its records. */
export async function resolveBy(by, deps) {
  if (DESKTOP_ID.test(by)) {
    const records = deps?.records || (await scanDesktopRecords()).records
    const node = find(classify({ records, roles: {} }), by)
    if (!node) throw refuse(`--by ${by} is not a session Zarvis knows`)
    return node.sessionId
  }
  if (!SAFE_ID.test(by)) throw refuse('--by must be a session id')
  return by
}

/** Run one command. Returns the exit code. `env` is read only for CLAUDE_CODE_SESSION_ID. */
export async function runEvent(argv, { home = zarvisHome(), now = Date.now(), env = process.env, deps, log = console.log, err = console.error } = {}) {
  let a
  try {
    a = parseArgs(argv)
    if (a.auto) {
      if (!['on', 'off', 'status'].includes(a.auto)) throw refuse('--auto takes on, off or status')
      if (a.auto !== 'status') {
        await withState((s) => {
          if (a.auto === 'off') s.autoEvents = false
          else delete s.autoEvents
        }, path.join(home, 'state.json'))
      }
      const on = autoEventsEnabled(home, env)
      log(`automatic push / PR events: ${on ? 'on' : 'off'}${env.ZARVIS_AUTO_EVENTS === '0' ? ' (ZARVIS_AUTO_EVENTS=0 in this environment)' : ''}`)
      return 0
    }
    let sessionId = ''
    if (a.by) sessionId = await resolveBy(a.by, deps)
    else if (SAFE_ID.test(env.CLAUDE_CODE_SESSION_ID || '')) sessionId = env.CLAUDE_CODE_SESSION_ID
    const ev = buildEvent({ text: a.text, kind: a.kind, url: a.url, sessionId }, now)
    if (a.dryRun) {
      log(`would log ${JSON.stringify(ev)}`)
      return 0
    }
    try {
      await appendEvent(home, ev)
    } catch (e) {
      err(`event: not logged (${e.code || e.message})`)
      return 0
    }
    log(`logged ${ev.kind}: ${ev.text}`)
    return 0
  } catch (e) {
    err(`event: ${e.message}`)
    if (!e.refusal) return 0 // anything unexpected (a lock timeout, say) must not fail the agent's command
    if (!a || (!a.text && !a.auto)) err(USAGE)
    return 1
  }
}
