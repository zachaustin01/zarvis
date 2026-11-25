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
  assert.equal(
    summarizeAntigravityInput('swarm', { action: 'add', name: 's2-spike', brief: 'Run benchmark' }),
    '[swarm:add @s2-spike] Run benchmark',
  )
  assert.equal(
    summarizeAntigravityInput('swarm', { action: 'status' }),
    '[swarm:status]',
  )
  assert.equal(
    summarizeAntigravityInput('swarm', { action: 'title', title: 'SAW Bot Tournament' }),
    '[swarm:title] SAW Bot Tournament',
  )
  assert.equal(
    summarizeAntigravityInput('post', { message: '@s2-spike looks good' }),
    '@s2-spike looks good',
  )
  assert.equal(
    summarizeAntigravityInput('post_message', { channel: 'parser', text: '@parser ship it' }),
    '[#parser] @parser ship it',
  )
  assert.equal(
    summarizeAntigravityInput('send_message', { Recipient: PARENT, Message: 'Done with task' }),
    `[to:${PARENT}] Done with task`,
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

  assert.deepEqual(
    buildAntigravityRoleTag({
      conversationId: ID,
      lastUserInput: `@s2-spike [zarvis: role=worker parent=${PARENT}]\nBrief...`,
    }, 70),
    { sessionId: ID, role: 'worker', parent: PARENT, at: 70 },
  )

  assert.deepEqual(
    buildAntigravityRoleTag({
      conversationId: ID,
      lastUserInput: `[Swarm Board #general]\nPosted by coordinator:\n[zarvis: role=worker parent=${PARENT}]\nWork through brief`,
    }, 80),
    { sessionId: ID, role: 'worker', parent: PARENT, at: 80 },
  )

  assert.deepEqual(
    buildAntigravityRoleTag({
      conversationId: ID,
      lastUserInput: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T15:45:46Z sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #4 for @packet-loa-1035-probe):\n\nYou own the deep-dive verification of **ONYX-50676**...\n</SYSTEM_MESSAGE>`,
    }, 90),
    { sessionId: ID, role: 'worker', parent: PARENT, at: 90 },
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

test('Antigravity hook auto-promotes untagged session to manager on swarm add or worker subagent', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-swarm-'))
  const prevHome = process.env.ZARVIS_HOME
  process.env.ZARVIS_HOME = home

  try {
    const basePayload = {
      conversationId: ID,
      workspacePaths: [home],
      transcriptPath: path.join(home, 'transcript.jsonl'),
      cwd: home,
    }

    // Turn 1: untagged prompt creates .first marker but no role .json
    await handleHook('pre_invocation', {
      ...basePayload,
      lastUserInput: 'Help me coordinate a swarm on this repo',
    })
    await assert.rejects(fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))

    // Routine browser subagent does NOT auto-promote to manager
    await handleHook('pre_tool_use', {
      ...basePayload,
      toolCall: { name: 'invoke_subagent', args: { TypeName: 'browser', Prompt: 'Open localhost:3000' } },
    })
    await assert.rejects(fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))

    // Calling swarm add auto-promotes untagged session to manager
    await handleHook('pre_tool_use', {
      ...basePayload,
      toolCall: { name: 'swarm', args: { action: 'add', name: 'w1', brief: '...' } },
    })
    const roleData = JSON.parse(await fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))
    assert.equal(roleData.sessionId, ID)
    assert.equal(roleData.role, 'manager')
    assert.equal(roleData.parent, '')

    // Another untagged session spawning a worker via invoke_subagent also auto-promotes
    await handleHook('pre_invocation', {
      ...basePayload,
      conversationId: PARENT,
      lastUserInput: 'Run a subagent worker',
    })
    await handleHook('pre_tool_use', {
      ...basePayload,
      conversationId: PARENT,
      toolCall: {
        name: 'invoke_subagent',
        args: { Role: 'Worker 1', Prompt: `[zarvis: role=worker parent=${PARENT}]\nFix tests` },
      },
    })
    const parentRole = JSON.parse(await fsp.readFile(path.join(home, 'roles', `${PARENT}.json`), 'utf8'))
    assert.equal(parentRole.role, 'manager')
  } finally {
    process.env.ZARVIS_HOME = prevHome
  }
})

test('Antigravity hook auto-registers swarm worker from SYSTEM_MESSAGE transcript without explicit zarvis tag', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-swarm-worker-'))
  const prevHome = process.env.ZARVIS_HOME
  process.env.ZARVIS_HOME = home

  try {
    const trFile = path.join(home, 'transcript.jsonl')
    const basePayload = {
      conversationId: ID,
      workspacePaths: [home],
      transcriptPath: trFile,
      cwd: home,
    }

    // pre_invocation fires with empty lastUserInput before transcript is flushed
    await handleHook('pre_invocation', {
      ...basePayload,
      lastUserInput: '',
    })
    await assert.rejects(fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))

    // Transcript flushes with native swarm SYSTEM_MESSAGE steps (no USER_INPUT, no [zarvis: ...] tag)
    const steps = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '...\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T15:45:46Z sender=63528f3d-7f1f-4413-ba1b-458118da5dd0 priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #4\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `...\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T15:45:46Z sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #4 for @packet-loa-1035-probe):\n\nYou own the deep-dive verification of **ONYX-50676**...\n</SYSTEM_MESSAGE>`,
      },
    ]
    await fsp.writeFile(trFile, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')

    // First tool call inspects transcript head and auto-registers worker attached to coordinator
    await handleHook('pre_tool_use', {
      ...basePayload,
      toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
    })

    const roleData = JSON.parse(await fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))
    assert.equal(roleData.sessionId, ID)
    assert.equal(roleData.role, 'worker')
    assert.equal(roleData.parent, PARENT)

    // transcriptMeta derives @<worker-name>: <brief summary> and spawnedFrom
    const meta = await transcriptMeta(trFile, ID)
    assert.equal(meta.title, '@packet-loa-1035-probe: You own the deep-dive verification of **ONYX-50676**...')
    assert.equal(meta.spawnedFrom, PARENT)
  } finally {
    process.env.ZARVIS_HOME = prevHome
  }
})

import { classify } from '../lib/roles.mjs'

test('buildQueue + classify infer worker role from spawnedFrom on idle swarm worker and stop hook persists role', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-spawned-'))
  const prevHome = process.env.ZARVIS_HOME
  process.env.ZARVIS_HOME = home

  try {
    const trFile = path.join(home, 'transcript.jsonl')
    const steps = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '...\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T15:45:46Z sender=63528f3d-7f1f-4413-ba1b-458118da5dd0 priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #4\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `...\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T15:45:46Z sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #4 for @packet-loa-1035-probe):\n\nYou own the deep-dive verification of **ONYX-50676**...\n</SYSTEM_MESSAGE>`,
      },
    ]
    await fsp.writeFile(trFile, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')

    // 1. Even with no roles/<ID>.json file yet, buildQueue + classify infer role=worker via spawnedFrom
    const rows = await buildQueue({
      markers: [],
      working: [
        {
          sessionId: ID,
          runtime: 'antigravity',
          state: 'idle',
          at: Date.now() - 5000,
          seen: Date.now() - 1000,
          cwd: home,
          transcriptPath: trFile,
          tool: '',
          command: '',
        },
      ],
      records: [],
      now: Date.now(),
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].spawnedFrom, PARENT)

    const nodes = classify({
      records: [],
      roles: { [PARENT]: { role: 'manager' } },
      sessions: rows,
    })
    assert.equal(nodes.get(ID)?.role, 'worker')
    assert.equal(nodes.get(ID)?.source, 'spawn')
    assert.equal(nodes.get(ID)?.managerId, PARENT)

    // 2. When stop hook fires on a short single-turn worker, ensureRoleTag persists roles/<ID>.json
    await handleHook('stop', {
      conversationId: ID,
      workspacePaths: [home],
      transcriptPath: trFile,
      cwd: home,
    })
    const roleData = JSON.parse(await fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))
    assert.equal(roleData.role, 'worker')
    assert.equal(roleData.parent, PARENT)
  } finally {
    process.env.ZARVIS_HOME = prevHome
  }
})

test('Antigravity hook and transcriptMeta recognize direct subagent SYSTEM_MESSAGE sessions', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-direct-subagent-'))
  const prevHome = process.env.ZARVIS_HOME
  process.env.ZARVIS_HOME = home

  try {
    const trFile = path.join(home, 'transcript.jsonl')
    const subagentMsg = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T17:44:17Z sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=You are the autonomous AI player representing Seat 1 (Player 2 - Agent-Blue) in the live match nnHEkZxoGHN of Settlers at War.\nServer is running locally at http://localhost:8000.\n</SYSTEM_MESSAGE>`
    await fsp.writeFile(
      trFile,
      JSON.stringify({
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: subagentMsg,
      }) + '\n',
    )

    // 1. transcriptMeta extracts spawnedFrom and initial instruction line as title
    const meta = await transcriptMeta(trFile, ID)
    assert.equal(meta.spawnedFrom, PARENT)
    assert.equal(
      meta.title,
      'You are the autonomous AI player representing Seat 1 (Player 2 - Agent-Blue) in ',
    )

    // 2. buildAntigravityRoleTag parses the subagent SYSTEM_MESSAGE
    const tag = buildAntigravityRoleTag({ conversationId: ID, lastUserInput: subagentMsg }, 100)
    assert.deepEqual(tag, { sessionId: ID, role: 'worker', parent: PARENT, at: 100 })

    // 3. handleHook registers worker role on stop or pre_tool_use
    await handleHook('stop', {
      conversationId: ID,
      workspacePaths: [home],
      transcriptPath: trFile,
      cwd: home,
    })
    const roleData = JSON.parse(await fsp.readFile(path.join(home, 'roles', `${ID}.json`), 'utf8'))
    assert.equal(roleData.role, 'worker')
    assert.equal(roleData.parent, PARENT)
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

test('Antigravity hook claims guard handles write_file/edit_file/run_command and wires guardPost on post_tool_use (#16)', async () => {
  const { readClaim, claimsDir, claimId } = await import('../lib/claims.mjs')
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-claims-'))
  const repoDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-repo-')))
  await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true })
  await fsp.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/feat/ONYX-101-guard\n')
  const prevHome = process.env.ZARVIS_HOME
  process.env.ZARVIS_HOME = home

  try {
    // 1. Session ID claims unclaimed checkout via write_file
    const resA = await handleHook('pre_tool_use', {
      conversationId: ID,
      cwd: repoDir,
      toolCall: { id: 'tc_a1', name: 'write_file', args: { Path: path.join(repoDir, 'src', 'index.js') } },
    })
    assert.deepEqual(resA, { decision: 'allow' })
    const claimFile = path.join(claimsDir(home), `${claimId(repoDir)}.json`)
    let claim = readClaim(claimFile)
    assert.equal(claim.holder.sessionId, ID)
    assert.equal(claim.label, 'ONYX-101')

    // 2. Another live session (PARENT) touching the same checkout via edit_file gets decision: 'ask' + full reason
    const resBAsk = await handleHook('pre_tool_use', {
      conversationId: PARENT,
      cwd: repoDir,
      toolCall: { id: 'tc_b1', name: 'edit_file', args: { Path: path.join(repoDir, 'src', 'index.js') } },
    })
    assert.equal(resBAsk.decision, 'ask')
    assert.match(resBAsk.reason, /Zarvis: .* is claimed by .*ONYX-101/)
    const blockedBeforeAllow = await readMarkers(path.join(home, 'blocked'))
    assert.equal(blockedBeforeAllow.length, 1)
    assert.equal(blockedBeforeAllow[0].sessionId, PARENT)
    assert.match(blockedBeforeAllow[0].message, /Zarvis: .* is claimed by/)
    assert.deepEqual(readClaim(claimFile).pending, { [PARENT]: 'tc_b1' })
    assert.deepEqual(readClaim(claimFile).shared, [])

    // 3. When user allows in Antigravity, post_tool_use runs with matching toolCall.id -> joins claim.shared & clears blocked
    await handleHook('post_tool_use', {
      conversationId: PARENT,
      cwd: repoDir,
      toolCall: { id: 'tc_b1', name: 'edit_file', args: { Path: path.join(repoDir, 'src', 'index.js') } },
    })
    claim = readClaim(claimFile)
    assert.equal(claim.shared.length, 1)
    assert.equal(claim.shared[0].sessionId, PARENT)
    assert.deepEqual(claim.pending, {})
    assert.equal((await readMarkers(path.join(home, 'blocked'))).length, 0)

    // 4. Subsequent single-file write_file/edit_file by sharer PARENT is allowed without asking
    const resBAgain = await handleHook('pre_tool_use', {
      conversationId: PARENT,
      cwd: repoDir,
      toolCall: { id: 'tc_b2', name: 'write_file', args: { Path: path.join(repoDir, 'src', 'other.js') } },
    })
    assert.deepEqual(resBAgain, { decision: 'allow' })

    // 5. Whole-tree git via run_command while shared still asks every time
    const resWhole = await handleHook('pre_tool_use', {
      conversationId: PARENT,
      cwd: repoDir,
      toolCall: { id: 'tc_b3', name: 'run_command', args: { CommandLine: 'git reset --hard' } },
    })
    assert.equal(resWhole.decision, 'ask')
    assert.match(resWhole.reason, /whole-tree git/)

    // 6. Also supports payloads that omit toolCall.id (deterministic fallback matching)
    const thirdId = 'c3c3c3c3-0000-4000-8000-000000000000'
    const resCAsk = await handleHook('pre_tool_use', {
      conversationId: thirdId,
      workspacePaths: [repoDir],
      toolCall: { name: 'write_file', args: { path: 'README.md' } },
    })
    assert.equal(resCAsk.decision, 'ask')
    await handleHook('post_tool_use', {
      conversationId: thirdId,
      workspacePaths: [repoDir],
      toolCall: { name: 'write_file', args: { path: 'README.md' } },
    })
    assert.ok(readClaim(claimFile).shared.some((s) => s.sessionId === thirdId))
  } finally {
    if (prevHome === undefined) delete process.env.ZARVIS_HOME
    else process.env.ZARVIS_HOME = prevHome
  }
})

test('Antigravity post_tool_use wires runAutoLinks for user-facing artifacts, HTML reports, and PR/MR commands (#16, #20)', async () => {
  const { readLinks, fileUrlOf } = await import('../lib/links.mjs')
  const { readEvents } = await import('../lib/events.mjs')
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-links-'))
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ag-work-'))
  const trFile = path.join(workDir, 'transcript.jsonl')
  const planMd = path.join(workDir, 'plan.md')
  const reportHtml = path.join(workDir, 'perf.html')
  await fsp.writeFile(planMd, '# Migration Plan\n\nStep 1.')
  await fsp.writeFile(reportHtml, '<title>Perf Benchmark</title><p>99ms</p>')
  const prevHome = process.env.ZARVIS_HOME
  process.env.ZARVIS_HOME = home

  try {
    // 1. User-facing write_file artifact pins file:// link with Markdown heading
    await handleHook('post_tool_use', {
      conversationId: ID,
      cwd: workDir,
      toolCall: {
        id: 't1',
        name: 'write_file',
        args: {
          Path: planMd,
          ArtifactMetadata: { UserFacing: true, RequestFeedback: true, Summary: 'Migration plan' },
        },
      },
    })

    // 2. Standalone .html write_file pins file:// link with <title> even without ArtifactMetadata
    await handleHook('post_tool_use', {
      conversationId: ID,
      cwd: workDir,
      toolCall: {
        id: 't2',
        name: 'write_file',
        args: { Path: 'perf.html' },
      },
    })

    // 3. Plain code write_file does NOT pin a link
    await handleHook('post_tool_use', {
      conversationId: ID,
      cwd: workDir,
      toolCall: {
        id: 't3',
        name: 'write_file',
        args: { Path: 'src/index.js' },
      },
    })

    // 4. run_command gh pr create with direct output pins PR #<n> AND logs pr event with URL
    await handleHook('post_tool_use', {
      conversationId: ID,
      cwd: workDir,
      toolCall: {
        id: 't4',
        name: 'run_command',
        args: { CommandLine: 'gh pr create --fill' },
      },
      output: 'https://github.com/zachaustin01/zarvis/pull/16\n',
    })

    // 5. run_command glab mr create reading output from transcriptPath at stepIdx (when stdin omits toolResponse)
    await fsp.writeFile(
      trFile,
      JSON.stringify({
        step_index: 9,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: 'Command exited with code 0.\n\nCommand output:\nhttps://gitlab.example.com/team/zarvis/-/merge_requests/20\n',
      }) + '\n',
    )
    await handleHook('post_tool_use', {
      conversationId: ID,
      cwd: workDir,
      transcriptPath: trFile,
      stepIdx: 9,
      toolCall: {
        id: 't5',
        name: 'run_command',
        args: { CommandLine: 'glab mr create --fill' },
      },
    })

    // 6. Failed run_command (payload.error set) does NOT pin bogus PR link
    await handleHook('post_tool_use', {
      conversationId: ID,
      cwd: workDir,
      error: 'exit status 1',
      output: 'https://github.com/zachaustin01/zarvis/pull/999\n',
      toolCall: {
        id: 't6',
        name: 'run_command',
        args: { CommandLine: 'gh pr create --fill' },
      },
    })

    assert.deepEqual(await readLinks(home, ID), [
      { url: fileUrlOf(planMd), label: 'Migration Plan' },
      { url: fileUrlOf(reportHtml), label: 'Perf Benchmark' },
      { url: 'https://github.com/zachaustin01/zarvis/pull/16', label: 'PR #16' },
      { url: 'https://gitlab.example.com/team/zarvis/-/merge_requests/20', label: 'MR !20' },
    ])
    const events = readEvents(home)
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'pr')
    assert.equal(events[0].url, 'https://github.com/zachaustin01/zarvis/pull/16')
  } finally {
    if (prevHome === undefined) delete process.env.ZARVIS_HOME
    else process.env.ZARVIS_HOME = prevHome
  }
})



