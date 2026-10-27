// The link CLI's logic: a session posts links (a dashboard, a served page, a PR, a report) that show as chips on its
// card. Writes only ~/.zarvis/links/<session>.json, so it works with the server stopped.
//
//   add <url|file path> [--label "text"] [--by <session id>]
//   list [--by <session id>] [--json]
//   remove <url|number> [--by <session id>]
//
// `--by` takes the CLI session id or the app's `local_…` id; without it the calling session is CLAUDE_CODE_SESSION_ID.
import { SAFE_ID } from './markers.mjs'
import { zarvisHome } from './claims.mjs'
import { resolveBy } from './events-cli.mjs'
import { addLink, readLinks, removeLink, fileUrlOf, MAX_LINKS } from './links.mjs'

const USAGE = 'usage: npm run link -- add <url|file path> [--label "text"] [--by <session id>] | list [--by <session id>] [--json] | remove <url|number> [--by <session id>]'
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = { '--label': 'label', '--by': 'by' }

export function parseArgs(argv) {
  const out = { cmd: argv[0] || '', arg: '', label: '', by: '', json: false }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (FLAGS[a]) {
      if (i + 1 >= rest.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = rest[++i]
    } else if (a === '--json') out.json = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else if (!out.arg) out.arg = a
    else throw refuse(`unexpected argument ${a}`)
  }
  return out
}

/** Run one command. Returns the exit code. `env` is read only for CLAUDE_CODE_SESSION_ID. */
export async function runLink(argv, { home = zarvisHome(), env = process.env, cwd = process.cwd(), deps, log = console.log, err = console.error } = {}) {
  let usage = false
  try {
    const a = parseArgs(argv)
    if (!['add', 'list', 'remove'].includes(a.cmd)) {
      usage = true
      throw refuse(a.cmd ? `unknown command ${a.cmd}` : 'no command given')
    }
    let id = ''
    if (a.by) id = await resolveBy(a.by, deps)
    else if (SAFE_ID.test(env.CLAUDE_CODE_SESSION_ID || '')) id = env.CLAUDE_CODE_SESSION_ID
    else throw refuse('cannot tell which session this is: pass --by <your session id>')
    if (a.cmd === 'list') {
      const links = await readLinks(home, id)
      if (a.json) log(JSON.stringify({ sessionId: id, links }, null, 2))
      else if (!links.length) log('no links')
      else links.forEach((l, i) => log(`${i + 1}. ${l.label} — ${l.url}`))
      return 0
    }
    if (!a.arg) {
      usage = true
      throw refuse(a.cmd === 'add' ? 'add needs a URL' : 'remove needs a URL or number')
    }
    if (a.cmd === 'add') {
      const l = await addLink(home, id, fileUrlOf(a.arg, cwd) || a.arg, a.label)
      log(`linked ${l.label} — ${l.url} (up to ${MAX_LINKS} per session; the oldest drops)`)
      return 0
    }
    const gone = await removeLink(home, id, fileUrlOf(a.arg, cwd) || a.arg)
    if (!gone) throw refuse(`no link matches ${a.arg}`)
    log(`removed ${gone.label} — ${gone.url}`)
    return 0
  } catch (e) {
    err(`link: ${e.message}`)
    if (usage) err(USAGE)
    return e.refusal ? 1 : 2
  }
}
