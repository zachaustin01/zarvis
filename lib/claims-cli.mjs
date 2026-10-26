// The claims CLI's logic: a session labels the checkout it works in (usually with its Jira key) or
// gives it up. Writes the same ~/.zarvis/claims/<id>.json the hook does. Never writes to Claude's files.
//
//   claim <KEY> [--root <dir>] --by <sessionId> [--dry-run]
//   release [--root <dir>] --by <sessionId> [--dry-run]     (no --root: every checkout the session holds or shares)
//   list [--json]
import path from 'node:path'
import {
  SAFE_ID,
  zarvisHome,
  claimsDir,
  claimId,
  findRoot,
  readClaim,
  readClaims,
  claimManual,
  releaseSession,
  holderLive,
  claimView,
  cleanKey,
  sessionName,
  sessionProcess,
  shortPath,
  realDeps,
  STALE_MS,
} from './claims.mjs'
import { DESKTOP_ID, scanDesktopRecords } from './sessions.mjs'
import { classify } from './roles.mjs'
import { find } from './park-cli.mjs'

const USAGE = 'usage: npm run claims -- claim <KEY> --by <session> [--root <dir>] [--dry-run] | release --by <session> [--root <dir>] [--dry-run] | list [--json]'

const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = { '--by': 'by', '--root': 'root' }

export function parseArgs(argv) {
  const out = { cmd: argv[0], key: '', by: '', root: '', json: false, dryRun: false }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (FLAGS[a]) {
      if (i + 1 >= rest.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = rest[++i]
    } else if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else if (out.cmd === 'claim' && !out.key) out.key = a
    else throw refuse(`unexpected argument ${a}`)
  }
  return out
}

/** The CLI session id for `--by`: a plain id as given, the app's `local_…` id looked up in its records. */
async function resolveBy(by, deps) {
  if (DESKTOP_ID.test(by)) {
    const records = deps?.records || (await scanDesktopRecords()).records
    const node = find(classify({ records, roles: {} }), by)
    if (!node) throw refuse(`--by ${by} is not a session Zarvis knows`)
    return node.sessionId
  }
  if (!SAFE_ID.test(by || '')) throw refuse('--by must be your own session id')
  return by
}

const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

/** Run one command. Returns the exit code; prints result lines (or one refusal line). */
export async function runClaims(argv, { home = zarvisHome(), now = Date.now(), cwd = process.cwd(), deps, probes = realDeps, name, self, log = console.log, err = console.error } = {}) {
  try {
    const a = parseArgs(argv)
    if (!['claim', 'release', 'list'].includes(a.cmd)) throw Object.assign(refuse(`unknown command ${a.cmd || '(none)'}`), { usage: true })

    if (a.cmd === 'list') {
      const views = readClaims(home).map((c) => claimView(c, now, probes)).sort((x, y) => y.holder.lastWrite - x.holder.lastWrite)
      if (a.json) log(JSON.stringify(views, null, 2))
      else if (!views.length) log('no checkouts claimed')
      for (const v of a.json ? [] : views) {
        const state = v.live ? 'live' : v.stale ? `stale (no write for ${Math.round(STALE_MS / 3600000)}h+)` : 'dead'
        const sharers = v.shared.length ? ` · sharing: ${v.shared.map((s) => s.name).join(', ')}` : ''
        log(`${v.label}  ${shortPath(v.root)}${v.branch && v.branch !== v.label ? `  [${v.branch}]` : ''}  held by ${v.holder.name} (${state}) · last write ${ago(now - v.holder.lastWrite)}${sharers}`)
      }
      return 0
    }

    if (!a.by) throw refuse('--by <your session id> is required')
    const sid = await resolveBy(a.by, deps)
    const root = a.root ? findRoot(path.resolve(cwd, a.root)) : a.cmd === 'claim' ? findRoot(cwd) : ''
    if ((a.cmd === 'claim' || a.root) && !root) throw refuse(`${a.root ? path.resolve(cwd, a.root) : cwd} is not inside a git checkout`)
    const ctx = { home, now, deps: probes, name: name || ((id) => sessionName(id)), self: self || (() => sessionProcess({ from: 'cli' })) }

    if (a.cmd === 'release') {
      const mine = readClaims(home).filter(({ claim }) => (!root || claim.root === root) && (claim.holder.sessionId === sid || claim.shared.some((s) => s.sessionId === sid)))
      if (!mine.length) {
        log(`nothing to release${root ? ` at ${shortPath(root)}` : ''}`)
        return 0
      }
      if (!a.dryRun) releaseSession(home, sid, root)
      for (const { claim } of mine) log(`${a.dryRun ? 'would release' : 'released'} ${claim.label} ${shortPath(claim.root)}`)
      return 0
    }

    // claim
    if (!a.key) throw refuse('claim needs a label: claim <KEY> (a Jira key such as PROJ-123)')
    const key = cleanKey(a.key)
    if (a.dryRun) {
      const cur = readClaim(path.join(claimsDir(home), `${claimId(root)}.json`))
      if (cur && cur.holder.sessionId !== sid && holderLive(cur, now, probes)) throw refuse(`${shortPath(root)} is claimed by “${cur.holder.name}”; it is theirs until released or abandoned`)
      log(`would ${!cur ? 'claim' : cur.holder.sessionId === sid ? 'relabel' : 'take over'} ${shortPath(root)} as ${key}`)
      return 0
    }
    const r = claimManual(root, key, sid, ctx)
    log(`${r.action} ${shortPath(r.root)} as ${r.label}`)
    return 0
  } catch (e) {
    err(`claims: ${e.message}`)
    if (e.usage) err(USAGE)
    return e.refusal ? 1 : 2
  }
}
