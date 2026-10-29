// The project CLI's logic: tag a session (or a manager, whose workers then follow it) with a project name, so its
// cost and its card group under that project instead of the folder it happens to run in.
// Writes only ~/.zarvis/projects.json (honours ZARVIS_HOME), so it works with the server stopped.
//
//   set <session id|name> <project> [--by <session id>]
//   clear <session id|name>
//   list [--json]
//
// A session is named by its CLI id, the app's `local_…` id, a unique id prefix (6+ characters), or its display name.
import { zarvisHome } from './claims.mjs'
import { resolveBy } from './events-cli.mjs'
import { buildLookup, findEntry } from './lookup.mjs'
import { liveDeps } from './roster-cli.mjs'
import { readTags, setTag, clearTag, cleanProject, MAX_PROJECT } from './project-tags.mjs'

const USAGE = 'usage: npm run project -- set <session id|name> <project> [--by <session id>] | clear <session id|name> | list [--json]'
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })

export function parseArgs(argv) {
  const out = { cmd: argv[0] || '', args: [], by: '', json: false }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--by') {
      if (i + 1 >= rest.length) throw refuse('--by needs a value')
      out.by = rest[++i]
    } else if (a === '--json') out.json = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else out.args.push(a)
  }
  return out
}

/** An entry by id/prefix, else by display name (exact, then a unique substring). */
export function findSession(entries, q) {
  const byId = findEntry(entries, q)
  if (byId.entry) return byId
  const want = String(q).trim().toLowerCase()
  const exact = entries.filter((e) => e.name.toLowerCase() === want || e.title.toLowerCase() === want)
  const hits = exact.length ? exact : entries.filter((e) => want.length >= 3 && (e.name.toLowerCase().includes(want) || e.title.toLowerCase().includes(want)))
  if (hits.length === 1) return { entry: hits[0] }
  return { error: hits.length ? `"${q}" matches ${hits.length} sessions (${hits.slice(0, 4).map((h) => h.name).join('; ')}…): use a session id` : byId.error }
}


/** Run one command. Returns the exit code. */
export async function runProject(argv, { home = zarvisHome(), world, now = Date.now(), log = console.log, err = console.error } = {}) {
  let usage = false
  try {
    const a = parseArgs(argv)
    if (!['set', 'clear', 'list'].includes(a.cmd)) {
      usage = true
      throw refuse(a.cmd ? `unknown command ${a.cmd}` : 'no command given')
    }
    const w = world || (await liveDeps())
    const tags = await readTags(home)
    const entries = await buildLookup({ ...w, projectTags: tags, now, all: true })
    if (a.cmd === 'list') {
      const rows = Object.entries(tags).map(([id, t]) => {
        const e = entries.find((x) => x.sessionId === id)
        return { sessionId: id, name: e?.name || '', role: e?.role || '', project: t.project, folderProject: e?.folderProject || '', by: t.by || '', at: t.at }
      })
      if (a.json) log(JSON.stringify({ tags: rows }, null, 2))
      else if (!rows.length) log('no explicit project tags (every session uses the folder it runs in; a worker follows its manager\'s tag)')
      else for (const r of rows) log(`${r.project} — ${r.name || '(unknown session)'}${r.role ? ` (${r.role})` : ''} — folder ${r.folderProject || '?'}\n    session \`${r.sessionId}\``)
      return 0
    }
    if (a.cmd === 'set' ? a.args.length < 2 : a.args.length < 1) {
      usage = true
      throw refuse(a.cmd === 'set' ? 'set needs a session and a project name' : 'clear needs a session')
    }
    if (a.cmd === 'set' && a.args.length > 2) {
      usage = true
      throw refuse('quote a project name that has spaces')
    }
    const { entry, error } = findSession(entries, a.args[0])
    if (error) throw refuse(error)
    const by = a.by ? await resolveBy(a.by, { records: w.records }) : ''
    if (a.cmd === 'clear') {
      const gone = await clearTag(home, entry.sessionId)
      if (!gone) throw refuse(`${entry.name} has no explicit project tag`)
      log(`cleared ${gone.project} from ${entry.name}; its project is now ${entry.folderProject || 'unknown'} (from its folder)`)
      return 0
    }
    const project = cleanProject(a.args[1])
    if (!project) throw refuse('project name is empty')
    if (project !== String(a.args[1]).trim()) log(`(project name cleaned to "${project}"; at most ${MAX_PROJECT} characters, one line)`)
    await setTag(home, entry.sessionId, project, by, now)
    const follows = entry.role === 'manager' ? ' Its workers follow it unless they have their own tag.' : ''
    log(`tagged ${entry.name} (${entry.role}) with project ${project}.${follows}`)
    return 0
  } catch (e) {
    err(`project: ${e.message}`)
    if (usage) err(USAGE)
    return e.refusal ? 1 : 2
  }
}

