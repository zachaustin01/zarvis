import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { parseCron, cleanCron, nextRuns, describeCron } from '../lib/cron.mjs'
import { addJob, readJobs, removeJob, parseJob, schedulesFile, MAX_JOBS, MAX_NAME, MAX_NOTE } from '../lib/schedule.mjs'
import { runSchedule, everyToCron, atToCron, parseArgs } from '../lib/schedule-cli.mjs'
import { importSchedules } from '../lib/schedule-import.mjs'
import { scheduleView, snapSpan, SPANS, MAX_RUNS } from '../lib/schedule-view.mjs'
import { ZOOMS, stepZoom, zoomOf, trackGeom, posPct, slidePct, slideClock, cullTicks, minGap, nextAfter, countdown, isSoon, axisMarks, lanePage, lanesPerPage, PAST_FRAC, TRACK_AHEAD } from '../public/schedule.js'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-sched-'))
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const fmt = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const runs = (spec, from, n = 3) => nextRuns(spec, from, n).map(fmt)

// ---- cron ----
test('cron: lists, ranges, steps and *', () => {
  const c = parseCron('*/20 9-11 1,15 * *')
  assert.deepEqual(c.minute, [0, 20, 40])
  assert.deepEqual(c.hour, [9, 10, 11])
  assert.deepEqual([...c.dom], [1, 15])
  assert.deepEqual(parseCron('5/20 * * * *').minute, [5, 25, 45]) // a start with a step runs to the end of the field
  assert.deepEqual(parseCron('10-30/10 * * * *').minute, [10, 20, 30])
  assert.equal(parseCron('* * * * *').minute.length, 60)
  assert.equal(parseCron('  0   *  * * *  ').spec, '0 * * * *')
})

test('cron: month and weekday names, 7 is Sunday', () => {
  assert.deepEqual([...parseCron('0 0 * jan,MAR-may *').month].sort((a, b) => a - b), [1, 3, 4, 5])
  assert.deepEqual([...parseCron('0 0 * * mon-fri').dow], [1, 2, 3, 4, 5])
  assert.deepEqual([...parseCron('0 0 * * 7').dow], [0])
  assert.deepEqual([...parseCron('0 0 * * 0,7').dow], [0])
})

test('cron: invalid specs are refused with a readable reason', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', '*/x * * * *', '1,,2 * * * *', '1/2/3 * * * *', 'a * * * *', '@hourly', '1-2-3 * * * *', '- * * * *', '* * * foo *', 'x'.repeat(200)]) {
    assert.throws(() => parseCron(bad), (e) => e.refusal === true, JSON.stringify(bad))
    assert.equal(cleanCron(bad), '')
  }
  assert.throws(() => parseCron(5), /text/)
})

test('cron: next runs for hourly, steps and fixed times', () => {
  const from = at(2026, 3, 10, 10, 20)
  assert.deepEqual(runs('0 * * * *', from), ['2026-03-10 11:00', '2026-03-10 12:00', '2026-03-10 13:00'])
  assert.deepEqual(runs('*/15 * * * *', from), ['2026-03-10 10:30', '2026-03-10 10:45', '2026-03-10 11:00'])
  assert.deepEqual(runs('30 9 * * *', from), ['2026-03-11 09:30', '2026-03-12 09:30', '2026-03-13 09:30'])
  assert.deepEqual(runs('0 9,13 * * *', at(2026, 3, 10, 9, 0)), ['2026-03-10 13:00', '2026-03-11 09:00', '2026-03-11 13:00']) // strictly after
  assert.deepEqual(runs('59 23 31 12 *', from, 1), ['2026-12-31 23:59'])
  assert.deepEqual(nextRuns('0 * * * *', from, 0), [])
})

test('cron: weekdays, months and ordinary day-of-month / day-of-week', () => {
  const from = at(2026, 3, 13, 12, 0) // a Friday
  assert.deepEqual(runs('0 9 * * 1-5', from), ['2026-03-16 09:00', '2026-03-17 09:00', '2026-03-18 09:00'])
  assert.deepEqual(runs('0 0 * * sun', from, 2), ['2026-03-15 00:00', '2026-03-22 00:00'])
  assert.deepEqual(runs('0 0 1 */3 *', from, 3), ['2026-04-01 00:00', '2026-07-01 00:00', '2026-10-01 00:00'])
  assert.deepEqual(runs('0 8 * jul *', from, 2), ['2026-07-01 08:00', '2026-07-02 08:00'])
})

test('cron: when both day-of-month and day-of-week are restricted either may match (standard cron)', () => {
  const from = at(2026, 3, 1, 0, 0) // Sunday 1 March
  // the 15th OR any Monday
  assert.deepEqual(runs('0 0 15 * mon', from, 5), ['2026-03-02 00:00', '2026-03-09 00:00', '2026-03-15 00:00', '2026-03-16 00:00', '2026-03-23 00:00'])
  // `*/2` starts with *, so day-of-month AND Friday
  assert.deepEqual(runs('0 0 */2 * fri', from, 3).every((s) => new Date(s.replace(' ', 'T')).getDay() === 5), true)
})

test('cron: impossible and rare dates are bounded, never loop', () => {
  const t0 = Date.now()
  assert.deepEqual(nextRuns('0 0 31 2 *', at(2026, 1, 1)), [])
  assert.deepEqual(nextRuns('0 0 30 2 *', at(2026, 1, 1)), [])
  assert.deepEqual(nextRuns('0 0 31 4,6,9,11 *', at(2026, 1, 1)), [])
  assert.deepEqual(runs('0 0 29 2 *', at(2026, 1, 1), 1), ['2028-02-29 00:00']) // a leap day is found
  assert.ok(Date.now() - t0 < 2000)
})

test('cron: `until` bounds the search and results are strictly increasing', () => {
  const from = at(2026, 3, 10, 0, 0)
  const r = nextRuns('* * * * *', from, 5000, from + 3600000)
  assert.equal(r.length, 60)
  assert.equal(r[59], from + 3600000)
  assert.ok(r.every((t, i) => i === 0 || t > r[i - 1]))
  assert.equal(nextRuns('0 0 * * *', from, 3, from).length, 0)
})

test('cron: describeCron says it in words', () => {
  const cases = { '0 * * * *': 'hourly, on the hour', '15 * * * *': 'hourly, at :15', '*/15 * * * *': 'every 15 minutes', '* * * * *': 'every minute', '0 9 * * 1-5': 'weekdays 09:00', '30 8 * * mon': 'weekly Mon 08:30', '0 0 1 * *': 'monthly on the 1st 00:00', '0 9,13 * * *': 'daily 09:00, 13:00', '0 */6 * * *': 'every 6 hours', '0 10 * * 0,6': 'weekends 10:00', '0 0 * * *': 'daily 00:00' }
  for (const [spec, words] of Object.entries(cases)) assert.equal(describeCron(spec), words, spec)
  assert.equal(describeCron('1,7,13 2,4,5 3 * *'), '1,7,13 2,4,5 3 * *') // too irregular: the spec itself
  assert.equal(describeCron('nonsense'), 'nonsense')
})

// DST: run in a child process with a fixed zone.
const inZone = (tz, code) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: tz }, cwd: ROOT, encoding: 'utf8' }))
const dstCode = (spec, y, m, d, n) => `import { nextRuns } from './lib/cron.mjs'
const f = (t) => new Date(t).toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
console.log(JSON.stringify(nextRuns('${spec}', new Date(${y}, ${m - 1}, ${d}, 0, 0).getTime(), ${n}).map(f)))`

test('cron DST (America/New_York): spring forward skips the missing hour, fall back runs once', () => {
  // 2026-03-08: 02:00 -> 03:00. Hourly runs lose 02:00 and never repeat or loop.
  assert.deepEqual(inZone('America/New_York', dstCode('0 * * * *', 2026, 3, 8, 5)), ['2026-03-08 01:00', '2026-03-08 03:00', '2026-03-08 04:00', '2026-03-08 05:00', '2026-03-08 06:00'])
  // A 02:30 job has no 02:30 that day: skipped, next is the following day.
  assert.deepEqual(inZone('America/New_York', dstCode('30 2 * * *', 2026, 3, 7, 3)), ['2026-03-07 02:30', '2026-03-09 02:30', '2026-03-10 02:30'])
  // 2026-11-01: 01:00-02:00 happens twice; a 01:30 job runs once.
  assert.deepEqual(inZone('America/New_York', dstCode('30 1 * * *', 2026, 10, 31, 3)), ['2026-10-31 01:30', '2026-11-01 01:30', '2026-11-02 01:30'])
  // A daily 09:00 job stays at 09:00 wall-clock across the change.
  assert.deepEqual(inZone('America/New_York', dstCode('0 9 * * *', 2026, 3, 7, 3)), ['2026-03-07 09:00', '2026-03-08 09:00', '2026-03-09 09:00'])
})

test('cron DST (Europe/London and a zone without DST)', () => {
  assert.deepEqual(inZone('Europe/London', dstCode('0 * * * *', 2026, 3, 29, 3)), ['2026-03-29 02:00', '2026-03-29 03:00', '2026-03-29 04:00']) // 01:00 does not exist
  assert.deepEqual(inZone('UTC', dstCode('0 */12 * * *', 2026, 3, 8, 3)), ['2026-03-08 12:00', '2026-03-09 00:00', '2026-03-09 12:00'])
})

// ---- store ----
test('store: add, replace by name, list, remove; atomic file under the given home', async () => {
  const home = await tmp()
  const a = await addJob(home, { name: 'Hourly check', cron: '0 * * * *', note: 'sources', link: 'https://example.com/dash' }, { now: 5 })
  assert.deepEqual(a, { name: 'Hourly check', cron: '0 * * * *', note: 'sources', link: 'https://example.com/dash', source: 'manual', addedAt: 5 })
  await addJob(home, { name: 'hourly CHECK', cron: '5 * * * *' }) // same name: replaces
  const jobs = await readJobs(home)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].cron, '5 * * * *')
  assert.deepEqual((await fsp.readdir(home)).sort(), ['schedules.json']) // no temp file left
  assert.equal((await removeJob(home, 'HOURLY check')).name, 'hourly CHECK')
  assert.equal(await removeJob(home, 'nope'), null)
  assert.deepEqual(await readJobs(home), [])
})

test('store: validation on write', async () => {
  const home = await tmp()
  const refused = (j) => assert.rejects(addJob(home, j), (e) => e.refusal === true, JSON.stringify(j).slice(0, 60))
  await refused({ name: '', cron: '* * * * *' })
  await refused({ name: 'a\nb', cron: '* * * * *' })
  await refused({ name: 'x'.repeat(MAX_NAME + 1), cron: '* * * * *' })
  await refused({ name: 'ok', cron: '* * * *' })
  await refused({ name: 'ok', cron: '* * * * *', note: 'n'.repeat(MAX_NOTE + 1) })
  await refused({ name: 'ok', cron: '* * * * *', link: 'javascript:alert(1)' })
  await refused({ name: 'ok', cron: '* * * * *', link: 'https://u:p@evil.example/' })
  await assert.rejects(fsp.stat(schedulesFile(home)))
  assert.equal((await addJob(home, { name: 'x'.repeat(MAX_NAME), cron: '* * * * *', note: 'n'.repeat(MAX_NOTE) })).name.length, MAX_NAME)
  assert.equal((await addJob(home, { name: 'doc', cron: '0 0 * * *', link: '/tmp/r.html' })).link, 'file:///tmp/r.html')
  assert.equal((await addJob(home, { name: 'multi', cron: '0 0 * * *', note: 'a\n  b\tc' })).note, 'a b c')
})

test('store: at most 40 jobs; replacing one when full is still allowed', async () => {
  const home = await tmp()
  for (let i = 0; i < MAX_JOBS; i++) await addJob(home, { name: `job ${i}`, cron: '0 * * * *' })
  await assert.rejects(addJob(home, { name: 'one too many', cron: '0 * * * *' }), /already 40/)
  await addJob(home, { name: 'job 3', cron: '5 * * * *' })
  assert.equal((await readJobs(home)).length, MAX_JOBS)
})

test('store: read tolerates a missing, corrupt or hand-edited file and revalidates every job', async () => {
  const home = await tmp()
  assert.deepEqual(await readJobs(home), [])
  await fsp.writeFile(schedulesFile(home), '{not json')
  assert.deepEqual(await readJobs(home), [])
  await fsp.writeFile(schedulesFile(home), JSON.stringify({ jobs: [null, 5, { name: 'ok', cron: '0 * * * *', source: 'weird', link: 'javascript:1', note: 'n\nm' }, { name: 'badcron', cron: '99 * * * *' }, { name: 'a'.repeat(99), cron: '* * * * *' }, { cron: '* * * * *' }, { name: 'ok', cron: '1 * * * *' }, ...Array.from({ length: 60 }, (_, i) => ({ name: `j${i}`, cron: '* * * * *' }))] }))
  const jobs = await readJobs(home)
  assert.equal(jobs.length, MAX_JOBS)
  assert.deepEqual(jobs[0], { name: 'ok', cron: '1 * * * *', note: '', link: '', source: 'manual', addedAt: 0 }) // the later duplicate wins, junk fields dropped
  assert.equal(parseJob({ name: 'x', cron: '* * * * *', source: 'claude' }).source, 'claude')
})

test('importers: none exist yet; a failing or invalid one is skipped and results are tagged claude', async () => {
  assert.deepEqual(await importSchedules(), [])
  const out = await importSchedules([async () => [{ name: 'Daily', cron: '0 8 * * *', source: 'manual' }, { name: 'bad', cron: 'x' }], async () => { throw new Error('boom') }])
  assert.deepEqual(out.map((j) => [j.name, j.source]), [['Daily', 'claude']])
})

// ---- CLI ----
async function cli(home, args, extra = {}) {
  const out = []
  const err = []
  const code = await runSchedule(args, { home, now: at(2026, 3, 10, 10, 20), log: (l) => out.push(l), err: (l) => err.push(l), ...extra })
  return { code, out, err }
}

test('cli: add, list, next, remove with a temp home', async () => {
  const home = await tmp()
  let r = await cli(home, ['add', 'Hourly check', '--cron', '0 * * * *', '--note', 'sources'])
  assert.equal(r.code, 0)
  assert.match(r.out[0], /scheduled Hourly check — 0 \* \* \* \* \(hourly, on the hour\)/)
  r = await cli(home, ['add', 'sync', '--every', '30m'])
  assert.equal(r.code, 0)
  r = await cli(home, ['list'])
  assert.deepEqual(r.out.map((l) => l.split(' — ')[0]), ['Hourly check', 'sync'])
  r = await cli(home, ['list', '--json'])
  const j = JSON.parse(r.out[0]).jobs
  assert.equal(j[0].next, at(2026, 3, 10, 11, 0))
  assert.equal(j[1].description, 'every 30 minutes')
  r = await cli(home, ['next', 'sync', '--count', '2'])
  assert.equal(r.out.length, 2)
  r = await cli(home, ['next', 'nope'])
  assert.equal(r.code, 1)
  r = await cli(home, ['remove', 'sync'])
  assert.deepEqual([r.code, r.out], [0, ['removed sync']])
  r = await cli(home, ['remove', 'sync'])
  assert.equal(r.code, 1)
  assert.equal((await cli(await tmp(), ['list'])).out[0], 'no schedules')
})

test('cli: --every and --at sugar, and refusals', () => {
  assert.equal(everyToCron('30m'), '*/30 * * * *')
  assert.equal(everyToCron('1m'), '* * * * *')
  assert.equal(everyToCron('1h'), '0 * * * *')
  assert.equal(everyToCron('6h'), '0 */6 * * *')
  assert.equal(everyToCron('120m'), '0 */2 * * *')
  assert.equal(everyToCron('1d'), '0 0 * * *')
  for (const bad of ['7m', '5h', '2d', '0m', 'x', '', '30', '1w', '90m']) assert.throws(() => everyToCron(bad), (e) => e.refusal, bad)
  assert.equal(atToCron('09:00,13:00'), '0 9,13 * * *')
  assert.equal(atToCron('9:30'), '30 9 * * *')
  for (const bad of ['25:00', '09:00,13:30', '9', '09:60', '']) assert.throws(() => atToCron(bad), (e) => e.refusal, bad)
  assert.throws(() => parseArgs(['add', 'a', 'b']), /unexpected argument/)
  assert.throws(() => parseArgs(['add', 'a', '--bogus']), /unknown option/)
  assert.throws(() => parseArgs(['add', 'a', '--cron']), /needs a value/)
})

test('cli: usage errors exit 1, nothing is written', async () => {
  const home = await tmp()
  for (const args of [[], ['frob'], ['add'], ['add', 'x'], ['add', 'x', '--cron', '* * * * *', '--every', '1h'], ['add', 'x', '--cron', 'bad']]) {
    const r = await cli(home, args)
    assert.equal(r.code, 1, args.join(' '))
  }
  assert.deepEqual(await fsp.readdir(home), [])
})

// ---- server route ----
test('scheduleView: runs within the window, next beyond it, dense flag, imported rows', async () => {
  const home = await tmp()
  const now = at(2026, 3, 10, 10, 20)
  await addJob(home, { name: 'hourly', cron: '0 * * * *' })
  await addJob(home, { name: 'minutely', cron: '* * * * *' })
  await addJob(home, { name: 'weekly', cron: '0 9 * * mon', note: 'n' })
  await addJob(home, { name: 'never', cron: '0 0 31 2 *' })
  const v = await scheduleView(home, { span: 3 * 3600000, now })
  assert.equal(v.now, now)
  assert.equal(v.span, 3 * 3600000)
  const by = Object.fromEntries(v.jobs.map((j) => [j.name, j]))
  assert.equal(by.hourly.runs[0], at(2026, 3, 10, 11, 0))
  assert.equal(by.hourly.desc, 'hourly, on the hour')
  assert.ok(by.hourly.runs.every((t) => t > now && t <= now + 3 * 3600000 * 1.15))
  assert.ok(by.minutely.runs.length >= 180 && by.minutely.runs.length <= 210)
  assert.equal(by.minutely.dense, false)
  assert.deepEqual(by.weekly.runs, [])
  assert.equal(by.weekly.next, at(2026, 3, 16, 9, 0))
  assert.equal(by.never.next, null)
  const wide = await scheduleView(home, { span: 7 * 86400000, now })
  assert.equal(wide.jobs.find((j) => j.name === 'minutely').dense, true)
  assert.equal(wide.jobs.find((j) => j.name === 'minutely').runs.length, MAX_RUNS)
  assert.equal(snapSpan(1), SPANS[0])
  assert.equal(snapSpan(5 * 3600000), SPANS[1])
  assert.equal(snapSpan(1e12), SPANS[3])
})

test('server: GET /api/schedule serves the temp home; a file link only opens for the job that holds it', async () => {
  const home = await tmp()
  const file = path.join(home, 'r.html')
  await fsp.writeFile(file, '<p>x</p>')
  await addJob(home, { name: 'job a', cron: '0 * * * *', link: file })
  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, ZARVIS_HOME: home, ZARVIS_PORT: String(port), ZARVIS_DESKTOP_SESSIONS: await tmp(), ZARVIS_DRY_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((res, rej) => { p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res()); p.on('exit', () => rej(new Error('server exited'))) })
    const base = `http://127.0.0.1:${port}`
    const d = await (await fetch(`${base}/api/schedule?span=10800000`)).json()
    assert.equal(d.jobs.length, 1)
    assert.equal(d.jobs[0].name, 'job a')
    assert.ok(d.jobs[0].runs.length >= 3 && d.jobs[0].next === d.jobs[0].runs[0] && d.now > 0)
    assert.equal((await fetch(`${base}/api/schedule?span=junk`)).status, 200)
    const url = d.jobs[0].link
    assert.match(url, /^file:\/\/\//)
    const post = (body) => fetch(`${base}/api/open-link`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))
    assert.deepEqual(await post({ schedule: 'job a', url }), { status: 200, body: { ok: true, mode: 'open', dryRun: true } })
    assert.equal((await post({ schedule: 'job b', url })).status, 404)
    assert.equal((await post({ schedule: 'job a', url: 'file:///etc/passwd' })).status, 404)
  } finally {
    p.kill()
  }
})

// ---- layout maths ----
test('layout: zoom steps stop at the ends', () => {
  assert.deepEqual(ZOOMS.map((z) => z.id), ['3h', '12h', '24h', '7d'])
  assert.equal(stepZoom('12h', 1), '24h')
  assert.equal(stepZoom('7d', 1), '7d')
  assert.equal(stepZoom('3h', -1), '3h')
  assert.equal(stepZoom('3h', 1), '12h')
  assert.equal(stepZoom('bogus', 1), '12h')
  assert.equal(zoomOf('nope').id, '12h')
})

test('layout: positions on the track, the slide, and that NOW stays put', () => {
  const span = 12 * 3600000
  const now0 = at(2026, 3, 10, 10, 0)
  const { base, trackMs } = trackGeom(now0, span)
  assert.equal(base, now0 - span * PAST_FRAC)
  assert.equal(trackMs, span * (TRACK_AHEAD + PAST_FRAC))
  const wholeView = (t, now) => (posPct(t, base, trackMs) + slidePct(now, now0, trackMs)) * (trackMs / span) // percent of the visible window
  assert.ok(Math.abs(wholeView(now0, now0) - PAST_FRAC * 100) < 1e-9) // now sits at the marker
  const later = now0 + 37 * 60000
  assert.ok(Math.abs(wholeView(later, later) - PAST_FRAC * 100) < 1e-9) // and still does after sliding
  assert.ok(Math.abs(wholeView(now0 + span * 0.92, now0) - 100) < 1e-9) // the window's right edge
  assert.equal(slidePct(now0, now0, trackMs), -0)
  assert.ok(slidePct(now0 + 60000, now0, trackMs) < 0)
  assert.equal(slideClock(1234567, false), 1234567)
  assert.equal(slideClock(120000 + 59999, true), 120000) // reduced motion: whole minutes
})

test('layout: tick culling keeps the first and enforces a minimum gap', () => {
  assert.deepEqual(cullTicks([1, 2, 3, 10, 11, 25], 5), [1, 10, 25])
  assert.deepEqual(cullTicks([], 5), [])
  assert.deepEqual(cullTicks([5, 6, 7], 0), [5, 6, 7])
  const mins = Array.from({ length: 180 }, (_, i) => i * 60000)
  assert.equal(cullTicks(mins, minGap(3 * 3600000, 800, 4)).length, 180) // 3h in 800px: a minute is 4.4px
  assert.ok(cullTicks(mins, minGap(7 * 86400000, 800)).length <= 4)
  assert.ok(minGap(3600000, 0) > 0)
})

test('layout: next run, countdown and the amber threshold', () => {
  assert.equal(nextAfter(10, [5, 10, 15, 20], 99), 15)
  assert.equal(nextAfter(25, [5, 20], 99), 99)
  assert.equal(nextAfter(25, [5, 20], 10), null)
  assert.equal(nextAfter(1, [], null), null)
  assert.equal(countdown(0), 'now')
  assert.equal(countdown(42000), 'in 42s')
  assert.equal(countdown(12 * 60000), 'in 12m')
  assert.equal(countdown(125 * 60000), 'in 2h 05m')
  assert.equal(countdown(3 * 86400000 + 4 * 3600000), 'in 3d 4h')
  assert.equal(isSoon(5 * 60000), true)
  assert.equal(isSoon(5 * 60000 + 1), false)
  assert.equal(isSoon(0), false)
})

test('layout: axis labels fall on local clock times', () => {
  const base = at(2026, 3, 10, 10, 20)
  const m3 = axisMarks(base, 3 * 3600000, '3h')
  assert.ok(m3.length >= 5)
  assert.ok(m3.every((m) => new Date(m.t).getMinutes() % 30 === 0))
  assert.deepEqual(m3.filter((m) => m.major).map((m) => m.text).slice(0, 2), ['11:00', '12:00'])
  assert.ok(axisMarks(base, 30 * 3600000, '24h').every((m) => new Date(m.t).getHours() % 3 === 0))
  const d7 = axisMarks(base, 8 * 86400000, '7d')
  assert.ok(d7.length >= 7 && d7.every((m) => new Date(m.t).getHours() === 0 && /^[A-Z]{3} \d+$/.test(m.text)))
})

test('layout: lanes per page and page slices', () => {
  assert.equal(lanesPerPage(500, 78), 6)
  assert.equal(lanesPerPage(10, 78), 1)
  assert.deepEqual(lanePage(14, 6, 0), { pages: 3, page: 0, start: 0, end: 6 })
  assert.deepEqual(lanePage(14, 6, 2), { pages: 3, page: 2, start: 12, end: 14 })
  assert.deepEqual(lanePage(14, 6, 9), { pages: 3, page: 2, start: 12, end: 14 }) // clamped
  assert.deepEqual(lanePage(0, 6, 0), { pages: 1, page: 0, start: 0, end: 0 })
})

// ---- wiring ----
const read = (f) => fsp.readFile(path.join(ROOT, f), 'utf8')
test('wiring: s opens the view, - and = zoom, palette commands, help sheet, README, skills', async () => {
  const [app, html, css, readme, pal, pkg] = await Promise.all([read('public/app.js'), read('public/index.html'), read('public/app.css'), read('README.md'), read('public/palette.js'), read('package.json')])
  assert.match(app, /e\.key === 's'\) setView\('schedule'\)/)
  assert.match(app, /e\.key === '-'\) zoomSched\(1\)/)
  assert.match(app, /e\.key === '=' \|\| e\.key === '\+'\) zoomSched\(-1\)/)
  for (const id of ['view-schedule', 'schedule-wider', 'schedule-narrower']) {
    assert.match(pal, new RegExp(`id: '${id}'`))
    assert.match(app, new RegExp(`'${id}': `))
  }
  assert.match(html, /data-view="schedule"/)
  assert.match(html, /<kbd>s<\/kbd><\/span><span class="kd">Schedule/)
  assert.match(html, /<kbd>-<\/kbd> <kbd>=<\/kbd><\/span><span class="kd">Schedule/)
  assert.match(html, /NO SCHEDULES/)
  assert.match(html, /npm run schedule -- add/)
  assert.match(readme, /## Schedule/)
  assert.match(readme, /`s` schedule/)
  assert.match(pkg, /"schedule": "node scripts\/schedule\.mjs"/)
  // Motion: the slide is a transform off one variable; reduced motion and a hidden tab stop the smooth slide.
  assert.match(css, /\.sc-trk\{[^}]*transform:translateX\(var\(--sx\)\);transition:transform 1s linear/)
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.sc-trk\{transition:none\}\}/)
  assert.match(css, /body\.tab-hidden \.sc-trk\{transition:none\}/)
  assert.doesNotMatch(css.slice(css.indexOf('Schedule view')), /overflow(-[xy])?:\s*(auto|scroll)|animation:/)
  assert.match(app, /slideClock\(now, reduceMotion\.matches\)/)
  assert.match(app, /classList\.contains\('tab-hidden'\)/)
  // The timeline lives outside #list, and a live push does not redraw it.
  assert.ok(html.indexOf('id="sched"') > html.indexOf('id="list"') && !/id="list"[^]*id="sched"[^]*<\/div>\s*<\/main>/.test(html.replace(/<section id="sched"[^]*?<\/section>/, '')))
  assert.match(app, /function renderInner\(\) \{\n  renderBar\(\)\n  if \(view === 'schedule'\) return/)
  // A web link is an escaped href; a file link is only ever a button that asks the server.
  assert.match(app, /safeUrl\(j\.link\)/)
  assert.match(app, /schedule: lane\.dataset\.n/)
  assert.doesNotMatch(css.slice(css.indexOf('Schedule view')), /--rd|\bred\b|#ff4d5e/)
  for (const skill of ['worker', 'manager', 'interface']) assert.match(await read(`skills/zarvis-${skill}/SKILL.md`), /scripts\/schedule\.mjs/, skill)
})
