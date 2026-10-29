// The cost report, shared by the server (/api/costs) and `npm run costs`: it joins the transcript usage
// (lib/usage.mjs), the price table (lib/pricing.mjs) and the session facts (lib/lookup.mjs) into lib/costs.mjs numbers.
// Read-only: nothing here writes anywhere.
//
//   costs [--range today|7d|30d|all] [--group project|manager] [--project <name>] [--manager <name|id>] [--top N] [--json]
//
// --group manager rolls each manager up with every worker attached to it (parked and archived ones included).
import { zarvisHome } from './claims.mjs'
import { buildLookup } from './lookup.mjs'
import { liveDeps } from './roster-cli.mjs'
import { readTags } from './project-tags.mjs'
import { loadPricing } from './pricing.mjs'
import { createUsageScanner } from './usage.mjs'
import { buildCosts, RANGES, normalizeRange } from './costs.mjs'

const USAGE = 'usage: npm run costs -- [--range today|7d|30d|all] [--group project|manager] [--project <name>] [--manager <name|id>] [--top N] [--json]'
const refuse = (msg) => Object.assign(new Error(msg), { refusal: true })
const FLAGS = { '--range': 'range', '--project': 'project', '--top': 'top', '--group': 'group', '--manager': 'manager' }

export function parseArgs(argv) {
  const out = { range: '7d', project: '', manager: '', group: '', top: 3, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (FLAGS[a]) {
      if (i + 1 >= argv.length) throw refuse(`${a} needs a value`)
      out[FLAGS[a]] = argv[++i]
    } else if (a === '--json') out.json = true
    else if (a.startsWith('--')) throw refuse(`unknown option ${a}`)
    else throw refuse(`unexpected argument ${a}`)
  }
  if (!RANGES.includes(out.range)) throw refuse(`--range must be one of ${RANGES.join(', ')}`)
  if (out.group && !['project', 'manager'].includes(out.group)) throw refuse('--group must be project or manager')
  if (!out.group) out.group = out.manager ? 'manager' : 'project'
  out.top = Math.max(0, Math.min(50, Math.floor(Number(out.top))))
  if (!Number.isFinite(out.top)) throw refuse('--top takes a number')
  return out
}

/** CLI session id -> the facts the cost model needs, from the same lookup the roster uses. */
export async function sessionFacts(world, now) {
  const entries = await buildLookup({ ...world, now, all: true })
  return new Map(entries.map((e) => [e.sessionId, { name: e.name, role: e.role, managerId: e.managerId, project: e.folderProject, cwd: e.cwd, desktopSessionId: e.desktopSessionId, parked: e.parked, done: e.done }]))
}

/** The whole report. `world` is liveDeps() (tests pass their own), `scanner` a createUsageScanner(). */
export async function costsReport({ scanner, world, home = zarvisHome(), range = '7d', project = '', manager = '', now = Date.now(), wait = true } = {}) {
  if (wait) await scanner.refresh()
  const [facts, pricing] = await Promise.all([sessionFacts(world, now), loadPricing(home)])
  const report = buildCosts(scanner.snapshot(), facts, { prices: pricing.prices, tags: world.projectTags || {}, range: normalizeRange(range), now, project, manager })
  return { ...report, pricing: { source: pricing.source, checked: pricing.checked, overridden: pricing.overridden }, scanning: scanner.progress.running ? { done: scanner.progress.done, total: scanner.progress.total } : null }
}

const usd = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0')
export const tok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
const RANGE_TEXT = { today: 'today', '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' }

export function formatReport(r, { top = 3, group = 'project' } = {}) {
  const byManager = group === 'manager'
  const t = r.totals
  const lines = [
    `Token cost by ${byManager ? 'manager (each with all its workers, parked ones included)' : 'project'}, ${RANGE_TEXT[r.range]} (API-equivalent estimate: tokens x published API list prices, not what you are billed)`,
    `Total ${usd(t.cost)} · ${tok(t.totalTokens)} tokens (in ${tok(t.tokens.input)}, out ${tok(t.tokens.output)}, cache read ${tok(t.tokens.cacheRead)}, cache write ${tok(t.tokens.cacheWrite5m + t.tokens.cacheWrite1h)}) · ${t.sessions} sessions · managers ${usd(t.roles.manager)}, workers ${usd(t.roles.worker)}, other ${usd(t.roles.other)}`,
  ]
  if (t.unpricedTokens) lines.push(`Unpriced: ${tok(t.unpricedTokens)} tokens on ${r.unpriced.map((u) => u.model).join(', ')} are counted but have no price, so they are NOT in the dollars.`)
  if (r.approx.length) lines.push(`Priced by family (approximate): ${r.approx.map((a) => `${a.model} as ${a.as}`).join(', ')}`)
  if (r.scanning) lines.push(`(still reading transcripts: ${r.scanning.done}/${r.scanning.total}; numbers are partial)`)
  const rows = byManager ? r.managers.filter((g) => g.kind !== 'unmanaged') : r.projects
  if (byManager) for (const g of r.managers.filter((x) => x.kind === 'unmanaged')) lines.push(`${g.name}: ${usd(g.cost)} · ${tok(g.totalTokens)} tokens · ${g.sessions} session${g.sessions === 1 ? '' : 's'} (workers attached to no manager; --json lists them)`)
  for (const p of rows) {
    lines.push('', `${byManager ? p.name : p.project}${!byManager && p.explicit ? ' (tagged)' : ''} — ${usd(p.cost)} · ${tok(p.totalTokens)} tokens · ${p.sessions} session${p.sessions === 1 ? '' : 's'}`)
    lines.push(`    tokens: in ${tok(p.tokens.input)}, out ${tok(p.tokens.output)}, cache read ${tok(p.tokens.cacheRead)}, cache write 5m ${tok(p.tokens.cacheWrite5m)} / 1h ${tok(p.tokens.cacheWrite1h)}`)
    if (byManager) lines.push(`    projects: ${p.projects.join(', ')}`)
    lines.push(`    spend: ${byManager ? 'the manager itself' : 'managers'} ${usd(p.roles.manager.cost)}, workers ${usd(p.roles.worker.cost)}, other ${usd(p.roles.other.cost)}`)
    lines.push(`    models: ${p.models.map((m) => `${m.model} ${m.priced ? usd(m.cost) : `unpriced (${tok(m.totalTokens)} tokens)`}`).join(', ')}`)
    if (p.unpricedTokens) lines.push(`    unpriced tokens: ${tok(p.unpricedTokens)} (not in the dollars)`)
    for (const s of p.top.slice(0, top)) lines.push(`    ${usd(s.cost).padStart(8)}  ${s.name || s.sessionId} — ${s.role}${s.parked ? ' (parked)' : ''}${byManager ? ` — ${s.project}` : ''} — ${tok(s.totalTokens)} tokens\n              session ${s.sessionId}`)
  }
  if (!rows.length && !(byManager && r.managers.length)) lines.push('', 'No token usage in this range.')
  lines.push('', `Prices: ${r.pricing.source} (checked ${r.pricing.checked})${r.pricing.overridden.length ? `, overridden in ~/.zarvis/pricing.json: ${r.pricing.overridden.join(', ')}` : ''}`)
  return lines.join('\n')
}

export async function runCosts(argv, { world, scanner = createUsageScanner(), home = zarvisHome(), now = Date.now(), log = console.log, err = console.error } = {}) {
  let a
  try {
    a = parseArgs(argv)
    const report = await costsReport({ scanner, world: world || (await liveDeps()), home, range: a.range, project: a.project, manager: a.manager, now })
    log(a.json ? JSON.stringify(report, null, 2) : formatReport(report, { top: a.top, group: a.group }))
    return 0
  } catch (e) {
    err(`costs: ${e.message}`)
    if (e.refusal) err(USAGE)
    return e.refusal ? 1 : 2
  }
}
