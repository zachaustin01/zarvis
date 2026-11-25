import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SOURCES, addJob, readJobs, upsertAutoJob, removeAutoJob, cleanupSessionSchedules, autoSchedulesEnabled } from '../lib/schedule.mjs'
import { importAntigravitySidecars, importSchedules } from '../lib/schedule-import.mjs'
import { autoSchedulesAntigravity } from '../hooks/zarvis-antigravity-hook.mjs'
import { autoSchedulesClaude } from '../hooks/zarvis-hook.mjs'

const execFileAsync = promisify(execFile)

test('SOURCES includes antigravity and auto helpers never overwrite or delete manual jobs', async () => {
  assert.deepEqual(SOURCES, ['manual', 'claude', 'antigravity'])
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-sched-auto-'))
  try {
    const sid = '11111111-1111-4111-8111-111111111111'
    await addJob(home, { name: 'Manual check', cron: '0 * * * *', owner: { session: sid, app: '' } })

    // Upsert with same name must not overwrite manual job
    const blocked = await upsertAutoJob(home, { name: 'Manual check', cron: '*/5 * * * *', externalId: 'ext-1', source: 'claude', owner: { session: sid, app: '' } })
    assert.equal(blocked, null)

    // Auto job with different name succeeds
    const auto = await upsertAutoJob(home, { name: 'Auto check', cron: '*/10 * * * *', externalId: 'ext-2', source: 'antigravity', owner: { session: sid, app: '' } })
    assert.equal(auto.source, 'antigravity')
    assert.equal(auto.externalId, 'ext-2')

    // cleanupSessionSchedules removes only non-manual jobs for that session
    const removed = await cleanupSessionSchedules(home, sid)
    assert.equal(removed, 1)
    const remaining = await readJobs(home)
    assert.deepEqual(remaining.map((j) => [j.name, j.source]), [['Manual check', 'manual']])

    // removeAutoJob never removes manual jobs even if externalId somehow matched
    assert.equal(await removeAutoJob(home, { externalId: 'ext-2' }), null)
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('autoSchedulesAntigravity registers CronExpression, DurationSeconds one-shot, and removes on manage_task kill', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-agy-sched-'))
  try {
    const sid = '22222222-2222-4222-8222-222222222222'
    // 1. CronExpression
    await autoSchedulesAntigravity(
      {
        conversationId: sid,
        toolCall: { name: 'schedule', args: { CronExpression: '15 * * * *', Prompt: 'Check build queue status' } },
      },
      home,
      `Scheduled task ${sid}/task-1`,
    )
    let jobs = await readJobs(home)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].source, 'antigravity')
    assert.equal(jobs[0].cron, '15 * * * *')
    assert.equal(jobs[0].externalId, `${sid}/task-1`)
    assert.equal(jobs[0].owner?.session, sid)

    // 2. DurationSeconds (one-shot timer)
    const fixedNow = new Date(2026, 10, 25, 10, 15, 0).getTime()
    await autoSchedulesAntigravity(
      {
        conversationId: sid,
        toolCall: { name: 'schedule', args: { DurationSeconds: 600, Prompt: 'Ping user after 10m' } },
      },
      home,
      `Timer ${sid}/task-2`,
      fixedNow,
    )
    jobs = await readJobs(home)
    assert.equal(jobs.length, 2)
    assert.equal(jobs[1].cron, '25 10 25 11 *')
    assert.equal(jobs[1].externalId, `${sid}/task-2`)

    // 3. manage_task kill removes only the matching taskId
    await autoSchedulesAntigravity(
      {
        conversationId: sid,
        toolCall: { name: 'manage_task', args: { Action: 'kill', TaskId: `${sid}/task-1` } },
      },
      home,
    )
    jobs = await readJobs(home)
    assert.deepEqual(jobs.map((j) => j.externalId), [`${sid}/task-2`])
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('autoSchedulesClaude registers CronCreate, removes CronDelete, and SessionEnd cleans up non-manual jobs', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-claude-sched-'))
  try {
    const sid = '33333333-3333-4333-8333-333333333333'
    await addJob(home, { name: 'Keep manual', cron: '0 9 * * *', owner: { session: sid, app: '' } })

    await autoSchedulesClaude(
      {
        session_id: sid,
        tool_name: 'CronCreate',
        tool_input: { cron: '*/5 * * * *', prompt: 'Poll CI pipeline' },
        tool_response: { id: 'cron-abc' },
      },
      home,
    )
    await autoSchedulesClaude(
      {
        session_id: sid,
        tool_name: 'CronCreate',
        tool_input: { cron: '0 * * * *', prompt: 'Hourly lint check' },
        tool_response: { id: 'cron-def' },
      },
      home,
    )
    let jobs = await readJobs(home)
    assert.equal(jobs.length, 3)

    // CronDelete removes cron-abc
    await autoSchedulesClaude({ session_id: sid, tool_name: 'CronDelete', tool_input: { id: 'cron-abc' } }, home)
    jobs = await readJobs(home)
    assert.deepEqual(jobs.map((j) => j.name), ['Keep manual', 'Hourly lint check'])

    // SessionEnd (`done` mode) removes remaining auto job but keeps manual job
    const hookPath = path.resolve('hooks/zarvis-hook.mjs')
    await new Promise((resolve, reject) => {
      const child = execFile('node', [hookPath, 'done'], { env: { ...process.env, ZARVIS_HOME: home } }, (err) => (err ? reject(err) : resolve()))
      child.stdin.end(JSON.stringify({ session_id: sid }))
    })
    jobs = await readJobs(home)
    assert.deepEqual(jobs.map((j) => [j.name, j.source]), [['Keep manual', 'manual']])
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('importAntigravitySidecars parses CRON_TZ, skips disabled/malformed sidecars, and preserves antigravity source', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-sidecar-'))
  try {
    const sidecarsDir = path.join(dir, 'sidecars')
    const userConfigFile = path.join(dir, 'user_config.json')
    await fsp.mkdir(path.join(sidecarsDir, 'morning-digest'), { recursive: true })
    await fsp.mkdir(path.join(sidecarsDir, 'disabled-in-cfg'), { recursive: true })
    await fsp.mkdir(path.join(sidecarsDir, 'disabled-self'), { recursive: true })
    await fsp.mkdir(path.join(sidecarsDir, 'not-schedule'), { recursive: true })
    await fsp.mkdir(path.join(sidecarsDir, 'bad-json'), { recursive: true })

    await fsp.writeFile(
      path.join(sidecarsDir, 'morning-digest', 'sidecar.json'),
      JSON.stringify({ builtin: 'schedule', display_name: 'Morning Digest', description: 'Summarize inbox', args: ['CRON_TZ=UTC 0 8 * * 1-5'] }),
    )
    await fsp.writeFile(
      path.join(sidecarsDir, 'disabled-in-cfg', 'sidecar.json'),
      JSON.stringify({ builtin: 'schedule', display_name: 'Disabled Cfg', args: ['0 9 * * *'] }),
    )
    await fsp.writeFile(
      path.join(sidecarsDir, 'disabled-self', 'sidecar.json'),
      JSON.stringify({ builtin: 'schedule', enabled: false, display_name: 'Disabled Self', args: ['0 10 * * *'] }),
    )
    await fsp.writeFile(
      path.join(sidecarsDir, 'not-schedule', 'sidecar.json'),
      JSON.stringify({ builtin: 'mcp', display_name: 'Other' }),
    )
    await fsp.writeFile(path.join(sidecarsDir, 'bad-json', 'sidecar.json'), '{not json')
    await fsp.writeFile(userConfigFile, JSON.stringify({ sidecars: { 'disabled-in-cfg': { enabled: false } } }))

    const raw = await importAntigravitySidecars({ sidecarsDir, userConfigFile })
    assert.equal(raw.length, 1)
    assert.equal(raw[0].name, 'Morning Digest')
    assert.equal(raw[0].cron, '0 8 * * 1-5')
    assert.equal(raw[0].source, 'antigravity')
    assert.match(raw[0].note, /Summarize inbox/)

    const validated = await importSchedules([() => importAntigravitySidecars({ sidecarsDir, userConfigFile })])
    assert.equal(validated.length, 1)
    assert.equal(validated[0].source, 'antigravity')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('ZARVIS_AUTO_SCHEDULES=0 and state.autoSchedules=false disable auto-registration', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-sched-optout-'))
  const prevEnv = process.env.ZARVIS_AUTO_SCHEDULES
  try {
    const sid = '44444444-4444-4444-8444-444444444444'
    assert.equal(autoSchedulesEnabled(home, {}), true)
    assert.equal(autoSchedulesEnabled(home, { ZARVIS_AUTO_SCHEDULES: '0' }), false)

    process.env.ZARVIS_AUTO_SCHEDULES = '0'
    await autoSchedulesClaude({ session_id: sid, tool_name: 'CronCreate', tool_input: { cron: '0 * * * *', prompt: 'Should skip' } }, home)
    assert.equal((await readJobs(home)).length, 0)

    delete process.env.ZARVIS_AUTO_SCHEDULES
    await fsp.writeFile(path.join(home, 'state.json'), JSON.stringify({ autoSchedules: false }))
    assert.equal(autoSchedulesEnabled(home, {}), false)
    await autoSchedulesAntigravity({ conversationId: sid, toolCall: { name: 'schedule', args: { CronExpression: '0 * * * *', Prompt: 'Should skip too' } } }, home)
    assert.equal((await readJobs(home)).length, 0)
  } finally {
    if (prevEnv === undefined) delete process.env.ZARVIS_AUTO_SCHEDULES
    else process.env.ZARVIS_AUTO_SCHEDULES = prevEnv
    await fsp.rm(home, { recursive: true, force: true })
  }
})
