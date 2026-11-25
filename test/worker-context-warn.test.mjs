import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readEvents } from '../lib/events.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE_HOOK = path.join(ROOT, 'hooks', 'zarvis-hook.mjs')
const AGY_HOOK = path.join(ROOT, 'hooks', 'zarvis-antigravity-hook.mjs')

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-wctx-'))

const claudeAsst = (input, cacheRead = 0, cacheCreate = 0) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: 120,
      },
    },
  })

const agyStep = (input, cacheRead = 0, stepIndex = 1) =>
  JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    model: 'gemini-3-pro',
    input_tokens: input,
    cache_read_tokens: cacheRead,
    output_tokens: 200,
  })

function runClaudeHook(mode, payload, home, extraEnv = {}) {
  return spawnSync(process.execPath, [CLAUDE_HOOK, mode], {
    input: JSON.stringify(payload),
    env: { ...process.env, ZARVIS_HOME: home, ...extraEnv },
  })
}

function runAgyHook(mode, payload, home, extraEnv = {}) {
  return spawnSync(process.execPath, [AGY_HOOK, mode], {
    input: JSON.stringify(payload),
    env: { ...process.env, ZARVIS_HOME: home, ...extraEnv },
  })
}

async function tagRole(home, sessionId, role, parent = '') {
  const dir = path.join(home, 'roles')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify({ sessionId, role, parent, at: Date.now() }))
}

test('Claude hook (work and idle): emits a one-time warn ticker event when a worker crosses threshold', async () => {
  const home = await tmp()
  const workDir = await tmp()
  try {
    const workerA = '11111111-aaaa-4111-8111-111111111111'
    const workerB = '22222222-bbbb-4222-8222-222222222222'
    await tagRole(home, workerA, 'worker', '99999999-0000-4000-8000-999999999999')
    await tagRole(home, workerB, 'worker', '99999999-0000-4000-8000-999999999999')

    const trA = path.join(workDir, `${workerA}.jsonl`)
    await fsp.writeFile(trA, `${claudeAsst(5_000, 150_000)}\n`) // 155k: below default 200k
    runClaudeHook('work', { session_id: workerA, transcript_path: trA, tool_name: 'Read' }, home)
    assert.deepEqual(readEvents(home), [])

    // Cross 200k on PostToolUse (`work`)
    await fsp.writeFile(trA, `${claudeAsst(5_000, 150_000)}\n${claudeAsst(15_000, 200_000)}\n`) // 215k
    runClaudeHook('work', { session_id: workerA, transcript_path: trA, tool_name: 'Edit' }, home)
    let evs = readEvents(home)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].kind, 'warn')
    assert.equal(evs[0].sessionId, workerA)
    assert.match(evs[0].text, /context at 215k tokens \(past 200k\) — consider handing off before idle/)

    // Subsequent PostToolUse (`work`) and Stop (`idle`) must NOT emit a second warning
    await fsp.writeFile(trA, `${claudeAsst(20_000, 260_000)}\n`) // 280k
    runClaudeHook('work', { session_id: workerA, transcript_path: trA, tool_name: 'Bash' }, home)
    runClaudeHook('idle', { session_id: workerA, transcript_path: trA, hook_event_name: 'Stop' }, home)
    assert.equal(readEvents(home).length, 1)

    // Worker B crosses custom threshold (120k) on Stop (`idle`), but NOT on SessionStart or subagent calls
    const trB = path.join(workDir, `${workerB}.jsonl`)
    await fsp.writeFile(trB, `${claudeAsst(10_000, 125_000)}\n`) // 135k
    const customEnv = { ZARVIS_WORKER_WARN_TOKENS: '120000' }

    runClaudeHook('idle', { session_id: workerB, transcript_path: trB, hook_event_name: 'SessionStart' }, home, customEnv)
    runClaudeHook('work', { session_id: workerB, transcript_path: trB, agent_id: 'subagent-12345678', tool_name: 'Read' }, home, customEnv)
    assert.equal(readEvents(home).length, 1)

    runClaudeHook('idle', { session_id: workerB, transcript_path: trB, hook_event_name: 'Stop' }, home, customEnv)
    evs = readEvents(home)
    assert.equal(evs.length, 2)
    assert.equal(evs[1].sessionId, workerB)
    assert.match(evs[1].text, /context at 135k tokens \(past 120k\)/)

    // Second Stop on Worker B does not re-emit
    runClaudeHook('idle', { session_id: workerB, transcript_path: trB, hook_event_name: 'Stop' }, home, customEnv)
    assert.equal(readEvents(home).length, 2)

    // .ctxwarn sentinel lives in roles/ and is non-.json so role readers skip it
    const roleFiles = await fsp.readdir(path.join(home, 'roles'))
    assert.ok(roleFiles.includes(`${workerA}.ctxwarn`))
    assert.ok(roleFiles.includes(`${workerB}.ctxwarn`))
  } finally {
    await fsp.rm(home, { recursive: true })
    await fsp.rm(workDir, { recursive: true })
  }
})

test('Claude hook skips manager, interface, untagged, state-overridden, and disabled thresholds', async () => {
  const home = await tmp()
  const workDir = await tmp()
  try {
    const tr = path.join(workDir, 'big.jsonl')
    await fsp.writeFile(tr, `${claudeAsst(50_000, 250_000)}\n`) // 300k

    const mgr = '33333333-cccc-4333-8333-333333333333'
    const iface = '44444444-dddd-4444-8444-444444444444'
    const untagged = '55555555-eeee-4555-8555-555555555555'
    const clearedWorker = '66666666-ffff-4666-8666-666666666666'
    const stateWorker = '77777777-aaaa-4777-8777-777777777777'

    await tagRole(home, mgr, 'manager')
    await tagRole(home, iface, 'interface')
    await tagRole(home, clearedWorker, 'worker')
    await fsp.writeFile(
      path.join(home, 'state.json'),
      JSON.stringify({
        overlays: {},
        roles: {
          [clearedWorker]: { role: 'none', at: 1 }, // overrides hook tag
          [stateWorker]: { role: 'worker', at: 1 }, // classified in UI without hook tag
        },
        parked: {},
        done: {},
      }),
    )

    for (const id of [mgr, iface, untagged, clearedWorker]) {
      runClaudeHook('work', { session_id: id, transcript_path: tr, tool_name: 'Read' }, home)
      runClaudeHook('idle', { session_id: id, transcript_path: tr, hook_event_name: 'Stop' }, home)
    }
    assert.deepEqual(readEvents(home), [])

    // Disabled via ZARVIS_WORKER_WARN_TOKENS=0: stateWorker does not warn
    runClaudeHook('work', { session_id: stateWorker, transcript_path: tr, tool_name: 'Read' }, home, { ZARVIS_WORKER_WARN_TOKENS: '0' })
    assert.deepEqual(readEvents(home), [])

    // Enabled (default): stateWorker warns once
    runClaudeHook('work', { session_id: stateWorker, transcript_path: tr, tool_name: 'Read' }, home)
    const evs = readEvents(home)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].sessionId, stateWorker)
  } finally {
    await fsp.rm(home, { recursive: true })
    await fsp.rm(workDir, { recursive: true })
  }
})

test('Antigravity hook (post_tool_use and stop): emits one-time warn for high-context worker and respects disable/roles', async () => {
  const home = await tmp()
  const workDir = await tmp()
  try {
    const agyWorker1 = '88888888-1111-4888-8888-888888888888'
    const agyWorker2 = '88888888-2222-4888-8888-888888888888'
    const agyMgr = '88888888-3333-4888-8888-888888888888'
    await tagRole(home, agyWorker1, 'worker', agyMgr)
    await tagRole(home, agyWorker2, 'worker', agyMgr)
    await tagRole(home, agyMgr, 'manager')

    const tr1 = path.join(workDir, 'agy1.jsonl')
    await fsp.writeFile(tr1, `${agyStep(20_000, 210_000, 1)}\n`) // 230k

    // Manager does not warn
    runAgyHook('post_tool_use', { conversationId: agyMgr, transcriptPath: tr1, toolCall: { name: 'read_file', args: {} } }, home)
    runAgyHook('stop', { conversationId: agyMgr, transcriptPath: tr1 }, home)
    assert.deepEqual(readEvents(home), [])

    // Disabled threshold does not warn
    runAgyHook('post_tool_use', { conversationId: agyWorker1, transcriptPath: tr1, toolCall: { name: 'read_file', args: {} } }, home, { ZARVIS_WORKER_WARN_TOKENS: 'false' })
    assert.deepEqual(readEvents(home), [])

    // Worker 1 warns once on post_tool_use, not again on stop
    runAgyHook('post_tool_use', { conversationId: agyWorker1, transcriptPath: tr1, toolCall: { name: 'read_file', args: {} } }, home)
    runAgyHook('stop', { conversationId: agyWorker1, transcriptPath: tr1 }, home)
    let evs = readEvents(home)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].sessionId, agyWorker1)
    assert.match(evs[0].text, /context at 230k tokens \(past 200k\)/)

    // Worker 2 warns once on stop, not again on subsequent post_tool_use
    const tr2 = path.join(workDir, 'agy2.jsonl')
    await fsp.writeFile(tr2, `${agyStep(50_000, 190_000, 1)}\n`) // 240k
    runAgyHook('stop', { conversationId: agyWorker2, transcriptPath: tr2 }, home)
    runAgyHook('post_tool_use', { conversationId: agyWorker2, transcriptPath: tr2, toolCall: { name: 'read_file', args: {} } }, home)
    evs = readEvents(home)
    assert.equal(evs.length, 2)
    assert.equal(evs[1].sessionId, agyWorker2)
    assert.match(evs[1].text, /context at 240k tokens \(past 200k\)/)
  } finally {
    await fsp.rm(home, { recursive: true })
    await fsp.rm(workDir, { recursive: true })
  }
})

test('server /api/queue and /api/tree highlight worker context gauge past threshold while leaving manager gauge normal', async () => {
  const home = await tmp()
  const desktop = await tmp()
  const cliProjects = await tmp()
  const workerId = '99999999-1111-4999-8999-999999999999'
  const mgrId = '99999999-2222-4999-8999-999999999999'

  const desktopOrg = path.join(desktop, 'acct', 'org')
  await fsp.mkdir(desktopOrg, { recursive: true })
  for (const [id, title] of [[workerId, 'Feature worker'], [mgrId, 'Project manager']]) {
    await fsp.writeFile(
      path.join(desktopOrg, `local_${id}.json`),
      JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, title, cwd: '/tmp/repo', lastActivityAt: Date.now() }),
    )
  }

  await tagRole(home, mgrId, 'manager')
  await tagRole(home, workerId, 'worker', mgrId)

  const tr = path.join(cliProjects, 'transcript.jsonl')
  await fsp.writeFile(tr, `${claudeAsst(20_000, 200_000)}\n`) // 220k (22% of 1M window)

  await fsp.mkdir(path.join(home, 'working'), { recursive: true })
  const now = Date.now()
  for (const id of [workerId, mgrId]) {
    await fsp.writeFile(
      path.join(home, 'working', `${id}.json`),
      JSON.stringify({ sessionId: id, state: 'idle', at: now, seen: now, cwd: '/tmp/repo', transcriptPath: tr }),
    )
  }

  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      ZARVIS_HOME: home,
      ZARVIS_PORT: String(port),
      ZARVIS_DESKTOP_SESSIONS: desktop,
      ZARVIS_CLI_PROJECTS: cliProjects,
      ZARVIS_DRY_OPEN: '1',
      ZARVIS_COSTS_WARM: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  try {
    await new Promise((res, rej) => {
      p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res())
      p.on('exit', () => rej(new Error('server exited')))
    })
    const base = `http://127.0.0.1:${port}`
    const q = await (await fetch(`${base}/api/queue`)).json()
    const wRow = q.queue.find((r) => r.sessionId === workerId)
    const mRow = q.queue.find((r) => r.sessionId === mgrId)
    assert.ok(wRow?.ctx)
    assert.equal(wRow.ctx.pct, 22)
    assert.equal(wRow.ctx.level, 'amber')
    assert.equal(wRow.ctx.workerWarn, true)
    assert.equal(wRow.ctx.warnAt, '200k')

    assert.ok(mRow?.ctx)
    assert.equal(mRow.ctx.pct, 22)
    assert.equal(mRow.ctx.level, '')
    assert.equal(mRow.ctx.workerWarn, undefined)

    const tree = await (await fetch(`${base}/api/tree`)).json()
    assert.equal(tree.managers[0].ctx.level, '')
    assert.equal(tree.managers[0].children[0].ctx.level, 'amber')
    assert.equal(tree.managers[0].children[0].ctx.workerWarn, true)
  } finally {
    p.kill()
    await fsp.rm(home, { recursive: true })
    await fsp.rm(desktop, { recursive: true })
    await fsp.rm(cliProjects, { recursive: true })
  }
})
