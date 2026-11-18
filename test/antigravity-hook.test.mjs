import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseMarker, readMarkers } from '../lib/markers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
import {
  summarizeAntigravityInput,
  askedQuestionAntigravity,
  buildAntigravityWorking,
  buildAntigravityQuestionMarker,
  buildAntigravityBlockedMarker,
  buildAntigravityRoleTag,
  handleHook,
} from '../hooks/zarvis-antigravity-hook.mjs'

const ID = 'ec33ebf9-0cba-4100-8142-c61503f6c587'
const PARENT = 'a1b2c3d4-0000-4000-8000-123456789abc'

test('summarizeAntigravityInput handles core Antigravity tool shapes', () => {
  assert.equal(summarizeAntigravityInput('run_command', { CommandLine: 'npm test' }), 'npm test')
  assert.equal(summarizeAntigravityInput('write_file', { Path: '/tmp/test.js' }), '/tmp/test.js')
  assert.equal(summarizeAntigravityInput('read_file', { Path: '/repo/README.md' }), '/repo/README.md')
  assert.equal(summarizeAntigravityInput('search_web', { query: 'antigravity hooks' }), 'antigravity hooks')
  assert.equal(
    summarizeAntigravityInput('invoke_subagent', { Role: 'Researcher', Prompt: 'Check the docs' }),
    '[Researcher] Check the docs',
  )

  const qa = summarizeAntigravityInput('ask_question', {
    questions: [
      { question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  })
  assert.match(qa, /Deploy now\?/)
  assert.match(qa, /• Yes/)
})

test('askedQuestionAntigravity detects unanswered ask_question in transcripts', () => {
  const qLines = [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Do something' },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which branch?' }] } }],
    },
  ].map((l) => JSON.stringify(l)).join('\n')

  const got = askedQuestionAntigravity(qLines)
  assert.ok(got)
  assert.equal(got.tool, 'ask_question')
  assert.match(got.ask, /Which branch\?/)

  const answeredLines = [
    qLines,
    JSON.stringify({ step_index: 3, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'main' }),
  ].join('\n')
  assert.equal(askedQuestionAntigravity(answeredLines), null)
})

test('buildAntigravityWorking constructs valid markers for Zarvis parseMarker', () => {
  const payload = {
    conversationId: ID,
    cwd: '/workspace',
    transcriptPath: '/workspace/transcript.jsonl',
    toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
  }
  const raw = buildAntigravityWorking(payload, null, 1000)
  assert.equal(raw.sessionId, ID)
  assert.equal(raw.state, 'working')
  assert.equal(raw.tool, 'run_command')
  assert.equal(raw.command, 'git status')

  const parsed = parseMarker(raw)
  assert.ok(parsed)
  assert.equal(parsed.sessionId, ID)
  assert.equal(parsed.state, 'working')
  assert.equal(parsed.command, 'git status')
})

test('buildAntigravityRoleTag matches tags in Antigravity prompts with or without wrapper', () => {
  assert.deepEqual(
    buildAntigravityRoleTag({ conversationId: ID, lastUserInput: '[zarvis: role=manager] hello' }, 50),
    { sessionId: ID, role: 'manager', parent: '', at: 50 },
  )

  assert.deepEqual(
    buildAntigravityRoleTag({
      conversationId: ID,
      lastUserInput: `<USER_REQUEST>\n[zarvis: role=worker parent=${PARENT}]\nDo task\n</USER_REQUEST>`,
    }, 60),
    { sessionId: ID, role: 'worker', parent: PARENT, at: 60 },
  )

  assert.equal(buildAntigravityRoleTag({ conversationId: ID, lastUserInput: 'Talk about [zarvis: role=interface]' }), null)
})

test('Antigravity hook lifecycle end-to-end writes and clears markers', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-'))
  const prevHome = process.env.ZARVIS_HOME
  process.env.ZARVIS_HOME = home

  try {
    const basePayload = {
      conversationId: ID,
      workspacePaths: [home],
      transcriptPath: path.join(home, 'transcript.jsonl'),
      cwd: home,
    }

    // 1. Session start -> writes idle working marker
    await handleHook('session_start', basePayload)
    let working = await readMarkers(path.join(home, 'working'))
    assert.equal(working.length, 1)
    assert.equal(working[0].sessionId, ID)
    assert.equal(working[0].state, 'idle')

    // 2. PreInvocation with role tag -> working marker & roles/ registered
    await handleHook('pre_invocation', {
      ...basePayload,
      lastUserInput: '[zarvis: role=manager] Coordinate work',
    })
    working = await readMarkers(path.join(home, 'working'))
    assert.equal(working[0].state, 'working')

    const roleData = JSON.parse(await fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))
    assert.equal(roleData.role, 'manager')

    // 3. PreToolUse -> updates working tool & command
    await handleHook('pre_tool_use', {
      ...basePayload,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    })
    working = await readMarkers(path.join(home, 'working'))
    assert.equal(working[0].tool, 'run_command')
    assert.equal(working[0].command, 'npm test')

    // 4. Stop -> returns to idle
    await handleHook('stop', basePayload)
    working = await readMarkers(path.join(home, 'working'))
    assert.equal(working[0].state, 'idle')
    const blocked = await readMarkers(path.join(home, 'blocked'))
    assert.equal(blocked.length, 0)
  } finally {
    process.env.ZARVIS_HOME = prevHome
  }
})

import { buildQueue } from '../lib/queue.mjs'
import {
  parsePbtxtTitle,
  findAntigravityTitle,
  findAntigravityTitleSync,
  transcriptMeta,
} from '../lib/sessions.mjs'

test('buildQueue surfaces Antigravity session with runtime tag and antigravity:// link', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-q-ag-'))
  const trFile = path.join(dir, 'transcript.jsonl')
  await fsp.writeFile(
    trFile,
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nImplement Antigravity queue integration\n</USER_REQUEST>',
    }) + '\n',
  )

  const m = {
    sessionId: ID,
    runtime: 'antigravity',
    state: 'working',
    at: Date.now() - 5000,
    seen: Date.now() - 1000,
    cwd: dir,
    transcriptPath: trFile,
    tool: 'run_command',
    command: 'git status',
  }

  const rows = await buildQueue({
    markers: [],
    working: [m],
    records: [],
    now: Date.now(),
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, ID)
  assert.equal(rows[0].runtime, 'antigravity')
  assert.equal(rows[0].title, 'Implement Antigravity queue integration')
  assert.equal(rows[0].link, `antigravity://conversation/${ID}`)
  assert.equal(rows[0].tool, 'run_command')
  assert.equal(rows[0].command, 'git status')
})

test('newSessionLink builds correct deep link for Antigravity vs Claude', async () => {
  const { newSessionLink } = await import('../lib/queue.mjs')
  assert.equal(newSessionLink('', '', 'antigravity'), 'antigravity://new')
  assert.equal(newSessionLink('/Users/zachaustin/repo', '', 'antigravity'), 'antigravity://new?path=%2FUsers%2Fzachaustin%2Frepo')
  assert.equal(newSessionLink('/Users/zachaustin/repo', '[zarvis: role=worker parent=123]', 'antigravity'), 'antigravity://new?path=%2FUsers%2Fzachaustin%2Frepo&q=%5Bzarvis%3A+role%3Dworker+parent%3D123%5D')
  assert.equal(newSessionLink('', '', 'claude'), 'claude://code/new')
  assert.equal(newSessionLink('/Users/zachaustin/repo', 'prompt', 'claude'), 'claude://code/new?folder=%2FUsers%2Fzachaustin%2Frepo&q=prompt')
})

test('parsePbtxtTitle extracts and unescapes Antigravity session titles', () => {
  assert.equal(
    parsePbtxtTitle('title:"Tracking NFL Ticket And Money Percentages" last_user_view_time:{seconds:123}'),
    'Tracking NFL Ticket And Money Percentages',
  )
  assert.equal(
    parsePbtxtTitle('title: "Renamed \\"Special\\" Session"\nlast_view: 123'),
    'Renamed "Special" Session',
  )
  assert.equal(parsePbtxtTitle('title: ""'), '')
  assert.equal(parsePbtxtTitle('last_user_view_time: { seconds: 123 }'), '')
  assert.equal(parsePbtxtTitle(null), '')
})

test('findAntigravityTitle reads title from annotations directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-agy-root-'))
  const annotDir = path.join(root, 'annotations')
  await fsp.mkdir(annotDir, { recursive: true })
  await fsp.writeFile(
    path.join(annotDir, `${ID}.pbtxt`),
    'title:"Tracking NFL Ticket And Money Percentages" last_user_view_time:{seconds:123}',
  )

  const candidatePath = path.join(root, 'brain', ID, '.system_generated', 'logs', 'transcript.jsonl')
  const titleAsync = await findAntigravityTitle(ID, candidatePath)
  assert.equal(titleAsync, 'Tracking NFL Ticket And Money Percentages')

  const titleSync = findAntigravityTitleSync(ID, candidatePath)
  assert.equal(titleSync, 'Tracking NFL Ticket And Money Percentages')

  const nonExistent = await findAntigravityTitle('00000000-0000-0000-0000-000000000000', candidatePath)
  assert.equal(nonExistent, '')
})

test('transcriptMeta prioritizes Antigravity annotation title over initial transcript prompt', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-agy-meta-'))
  const trDir = path.join(root, 'brain', ID, '.system_generated', 'logs')
  const annotDir = path.join(root, 'annotations')
  await fsp.mkdir(trDir, { recursive: true })
  await fsp.mkdir(annotDir, { recursive: true })

  const trFile = path.join(trDir, 'transcript.jsonl')
  await fsp.writeFile(
    trFile,
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\ni\'m interested in seeing if we can track % of tickets and % of money placed on NFL sides for this upcoming weekend\n</USER_REQUEST>',
    }) + '\n',
  )
  await fsp.writeFile(
    path.join(annotDir, `${ID}.pbtxt`),
    'title:"Tracking NFL Ticket And Money Percentages" last_user_view_time:{seconds:123}',
  )

  // With annotation file present: annotation title wins
  const metaWithAnnot = await transcriptMeta(trFile, ID)
  assert.equal(metaWithAnnot.title, 'Tracking NFL Ticket And Money Percentages')

  // Without annotation file: fallback to first line of prompt
  const otherId = '00000000-1111-2222-3333-444444444444'
  const otherTrDir = path.join(root, 'brain', otherId, '.system_generated', 'logs')
  await fsp.mkdir(otherTrDir, { recursive: true })
  const otherTrFile = path.join(otherTrDir, 'transcript.jsonl')
  await fsp.writeFile(
    otherTrFile,
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nFallback prompt title\n</USER_REQUEST>',
    }) + '\n',
  )
  const metaFallback = await transcriptMeta(otherTrFile, otherId)
  assert.equal(metaFallback.title, 'Fallback prompt title')
})

test('buildQueue reflects renamed Antigravity title from annotations', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-agy-queue-'))
  const trDir = path.join(root, 'brain', ID, '.system_generated', 'logs')
  const annotDir = path.join(root, 'annotations')
  await fsp.mkdir(trDir, { recursive: true })
  await fsp.mkdir(annotDir, { recursive: true })

  const trFile = path.join(trDir, 'transcript.jsonl')
  await fsp.writeFile(
    trFile,
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\ni\'m interested in seeing if we can track % of tickets\n</USER_REQUEST>',
    }) + '\n',
  )
  await fsp.writeFile(
    path.join(annotDir, `${ID}.pbtxt`),
    'title:"Tracking NFL Ticket And Money Percentages" last_user_view_time:{seconds:123}',
  )

  const m = {
    sessionId: ID,
    runtime: 'antigravity',
    state: 'idle',
    at: Date.now() - 5000,
    seen: Date.now() - 1000,
    cwd: root,
    transcriptPath: trFile,
    tool: '',
    command: '',
  }

  const rows = await buildQueue({
    markers: [],
    working: [m],
    records: [],
    now: Date.now(),
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'Tracking NFL Ticket And Money Percentages')
})

test('server: POST /api/open triggers Antigravity search flow and returns title', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-open-ag-'))
  const trDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-tr-ag-'))
  const trFile = path.join(trDir, 'transcript.jsonl')
  await fsp.writeFile(
    trFile,
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nFix Antigravity open handling\n</USER_REQUEST>',
    }) + '\n',
  )
  await fsp.mkdir(path.join(home, 'working'), { recursive: true })
  await fsp.writeFile(
    path.join(home, 'working', `${ID}.json`),
    JSON.stringify({
      sessionId: ID,
      runtime: 'antigravity',
      state: 'working',
      at: Date.now() - 5000,
      seen: Date.now() - 1000,
      cwd: trDir,
      transcriptPath: trFile,
      tool: 'run_command',
      command: 'git status',
    }),
  )

  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      ZARVIS_HOME: home,
      ZARVIS_PORT: String(port),
      ZARVIS_DESKTOP_SESSIONS: await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ds-')),
      ZARVIS_DRY_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  try {
    await new Promise((res, rej) => {
      p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res())
      p.on('exit', () => rej(new Error('server exited')))
    })
    const base = `http://127.0.0.1:${port}`
    // Test 1: By default without opt-in, keystrokesUsed is false
    const resDefault = await fetch(`${base}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ sessionId: ID }),
    })
    const dataDefault = await resDefault.json()
    assert.equal(resDefault.status, 200)
    assert.equal(dataDefault.ok, true)
    assert.equal(dataDefault.runtime, 'antigravity')
    assert.equal(dataDefault.name, 'Fix Antigravity open handling')
    assert.equal(dataDefault.keystrokesUsed, false)
    assert.equal(dataDefault.dryRun, true)

    // Test 2: With client opt-in ({ keystrokes: true }), keystrokesUsed is true
    const resOptIn = await fetch(`${base}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ sessionId: ID, keystrokes: true }),
    })
    const dataOptIn = await resOptIn.json()
    assert.equal(resOptIn.status, 200)
    assert.equal(dataOptIn.ok, true)
    assert.equal(dataOptIn.keystrokesUsed, true)
    assert.equal(dataOptIn.dryRun, true)

    // Test 3: /api/new with runtime: 'antigravity' respects opt-in
    const resNewDefault = await fetch(`${base}/api/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ role: 'worker', runtime: 'antigravity' }),
    })
    const dataNewDefault = await resNewDefault.json()
    assert.equal(dataNewDefault.ok, true)
    assert.equal(dataNewDefault.keystrokesUsed, false)

    const resNewOptIn = await fetch(`${base}/api/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ role: 'worker', runtime: 'antigravity', keystrokes: true }),
    })
    const dataNewOptIn = await resNewOptIn.json()
    assert.equal(dataNewOptIn.ok, true)
    assert.equal(dataNewOptIn.keystrokesUsed, true)
  } finally {
    p.kill()
  }
})

test('server: ZARVIS_KEYSTROKES=0 forbids keystrokes even when requested', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-test-'))
  const trDir = path.join(home, 'projects', 'p1')
  await fsp.mkdir(trDir, { recursive: true })
  const trFile = path.join(trDir, 'transcript.jsonl')
  await fsp.writeFile(
    trFile,
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nForbid test\n</USER_REQUEST>',
    }) + '\n',
  )
  await fsp.mkdir(path.join(home, 'working'), { recursive: true })
  await fsp.writeFile(
    path.join(home, 'working', `${ID}.json`),
    JSON.stringify({
      sessionId: ID,
      runtime: 'antigravity',
      state: 'working',
      at: Date.now() - 5000,
      seen: Date.now() - 1000,
      cwd: trDir,
      transcriptPath: trFile,
    }),
  )

  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      ZARVIS_HOME: home,
      ZARVIS_PORT: String(port),
      ZARVIS_DESKTOP_SESSIONS: await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ds-')),
      ZARVIS_DRY_OPEN: '1',
      ZARVIS_KEYSTROKES: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  try {
    await new Promise((res, rej) => {
      p.stdout.on('data', (d) => /Zarvis →/.test(String(d)) && res())
      p.on('exit', () => rej(new Error('server exited')))
    })
    const base = `http://127.0.0.1:${port}`
    const res = await fetch(`${base}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ sessionId: ID, keystrokes: true }),
    })
    const data = await res.json()
    assert.equal(data.ok, true)
    assert.equal(data.keystrokesUsed, false)
  } finally {
    p.kill()
  }
})



