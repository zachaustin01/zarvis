import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseMarker, readMarkers, hookStatus } from '../lib/markers.mjs'
import { pendingTool, buildMarker, buildWorking, summarizeInput, askedQuestion, buildQuestionMarker } from '../hooks/zarvis-hook.mjs'

const ID = 'f6cce3a1-cd4c-4de5-bb8d-e7375ea36a85'

test('parseMarker accepts a valid marker and rejects bad ones', () => {
  assert.equal(parseMarker({ sessionId: ID, at: 5, tool: 'Bash' }).tool, 'Bash')
  assert.equal(parseMarker({ sessionId: '../x', at: 5 }), null)
  assert.equal(parseMarker({ sessionId: ID }), null)
  assert.equal(parseMarker(null), null)
})

test('readMarkers skips junk and mismatched file names', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-'))
  await fsp.writeFile(path.join(dir, `${ID}.json`), JSON.stringify({ sessionId: ID, at: 1 }))
  await fsp.writeFile(path.join(dir, 'broken.json'), '{nope')
  await fsp.writeFile(path.join(dir, 'other-session-id.json'), JSON.stringify({ sessionId: ID, at: 1 }))
  const got = await readMarkers(dir)
  assert.deepEqual(got.map((m) => m.sessionId), [ID])
  assert.deepEqual(await readMarkers(path.join(dir, 'missing')), [])
})

test('pendingTool finds the tool_use with no result after it', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'rm -rf build' } }] } },
  ].map((l) => JSON.stringify(l))
  assert.deepEqual(pendingTool('partial-line-garbage\n' + lines.join('\n')), { tool: 'Bash', command: 'rm -rf build' })
  assert.deepEqual(pendingTool(lines.slice(0, 2).join('\n')), { tool: '', command: '' })
})

test('buildMarker falls back to the message text for the tool name', async () => {
  const m = await buildMarker({ session_id: ID, message: 'Claude needs your permission to use WebFetch' }, 42)
  assert.equal(m.tool, 'WebFetch')
  assert.equal(m.at, 42)
  assert.equal(summarizeInput('Edit', { file_path: '/a/b' }), '/a/b')
})

test('buildWorking keeps the turn start across refreshes and restarts it without one', () => {
  assert.equal(buildWorking({ session_id: ID }, { at: 10 }, 99).at, 10)
  assert.equal(buildWorking({ session_id: ID }, { at: 10 }, 99).seen, 99)
  assert.equal(buildWorking({ session_id: ID }, null, 99).at, 99)
})

test('buildWorking restarts the clock when the state changes', () => {
  assert.equal(buildWorking({ session_id: ID }, { at: 10, state: 'idle' }, 99).at, 99)
  assert.equal(buildWorking({ session_id: ID }, { at: 10, state: 'idle' }, 99, 'idle').at, 10)
  assert.equal(buildWorking({ session_id: ID }, null, 99, 'idle').state, 'idle')
})

test('hookStatus: live, stale, absent, and never a guess', () => {
  const now = 100_000_000
  const min = 60_000
  assert.deepEqual(hookStatus([], now), { status: 'absent', lastAt: 0 })
  assert.equal(hookStatus([{ at: now - 2 * min }], now).status, 'live') // blocked marker
  assert.equal(hookStatus([{ at: now - 60 * min, seen: now - min }], now).status, 'live') // working marker's seen wins
  const old = hookStatus([{ at: now - 30 * min }, { at: now - 20 * min, seen: now - 20 * min }], now)
  assert.deepEqual(old, { status: 'stale', lastAt: now - 20 * min })
  assert.equal(hookStatus([{ at: now - 11 * min }], now, 12 * min).status, 'live') // custom threshold
})

// ---- role tag: first prompt, at its start only ----
import { spawnSync } from 'node:child_process'
import { buildRoleTag } from '../hooks/zarvis-hook.mjs'
import { rolePrompt } from '../lib/roles.mjs'

const PARENT = 'a1b2c3d4-0000-4000-8000-123456789abc'
const HOOK = new URL('../hooks/zarvis-hook.mjs', import.meta.url).pathname

test('buildRoleTag only matches a tag at the start of the prompt', () => {
  const tag = (prompt) => buildRoleTag({ session_id: ID, prompt }, 7)
  assert.deepEqual(tag('[zarvis: role=manager] hi'), { sessionId: ID, role: 'manager', parent: '', at: 7 })
  assert.equal(tag('  \n\t[zarvis: role=interface] hi').role, 'interface')
  assert.equal(tag('Build the skill that handles [zarvis: role=interface] tags'), null)
  assert.equal(tag('hello\n[zarvis: role=worker]'), null)
  assert.equal(tag(`[zarvis: role=worker parent=${PARENT}]`).parent, PARENT)
  for (const [role, parent] of [['interface', ''], ['manager', ''], ['worker', PARENT]]) {
    const t = tag(rolePrompt(role, parent))
    assert.equal(t.role, role)
    assert.equal(t.parent, parent)
  }
})

test('the hook registers a role only from the first prompt, and never overwrites', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hook-'))
  const run = (mode, id, prompt) =>
    spawnSync('node', [HOOK, mode], { input: JSON.stringify({ session_id: id, prompt }), env: { ...process.env, ZARVIS_HOME: home } })
  const role = async (id) => {
    try {
      return JSON.parse(await fsp.readFile(path.join(home, 'roles', `${id}.json`), 'utf8'))
    } catch {
      return null
    }
  }
  const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  run('idle', A, '') // SessionStart first
  run('start', A, rolePrompt('manager'))
  assert.equal((await role(A)).role, 'manager')
  run('start', A, '[zarvis: role=interface]') // later prompt: no overwrite
  assert.equal((await role(A)).role, 'manager')

  const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  run('start', B, 'Please build the thing for [zarvis: role=interface]')
  run('start', B, '[zarvis: role=interface] now')
  assert.equal(await role(B), null)

  const C = 'cccccccc-3333-4333-8333-cccccccccccc'
  run('start', C, 'plain first prompt')
  run('start', C, rolePrompt('worker', PARENT))
  assert.equal(await role(C), null)

  const D = 'dddddddd-4444-4444-8444-dddddddddddd'
  await fsp.mkdir(path.join(home, 'roles'), { recursive: true })
  await fsp.writeFile(path.join(home, 'roles', `${D}.json`), JSON.stringify({ sessionId: D, role: 'worker', parent: '', at: 1 }))
  run('start', D, '[zarvis: role=manager]')
  assert.equal((await role(D)).role, 'worker')
})

// ---- subagent permission prompts: payloads carry the PARENT session_id plus agent_id ----
test('a subagent prompt blocks the parent, survives other agents and Stop, and clears correctly', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hook-'))
  const S = 'cccccccc-3333-4333-8333-cccccccccccc'
  const sub = { agent_id: 'a1f2e3d4c5b6a7980', agent_type: 'general-purpose' }
  const base = { session_id: S, cwd: '/repo', transcript_path: path.join(home, `${S}.jsonl`) }
  const run = (mode, ev, extra = {}) =>
    spawnSync('node', [HOOK, mode], { input: JSON.stringify({ ...base, hook_event_name: ev, ...extra }), env: { ...process.env, ZARVIS_HOME: home } })
  const read = async (dir) => {
    try {
      return JSON.parse(await fsp.readFile(path.join(home, dir, `${S}.json`), 'utf8'))
    } catch {
      return null
    }
  }
  // The parent's transcript ends on its pending Agent call (what a bare Notification would show).
  await fsp.writeFile(base.transcript_path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'run it' } }] } }) + '\n')

  run('start', 'UserPromptSubmit', { prompt: 'go' })
  run('resume', 'PreToolUse', { tool_name: 'Agent' })
  run('resume', 'PreToolUse', { tool_name: 'Bash', ...sub })
  // Immediate PermissionRequest, then the ~6 s Notification for the same prompt.
  run('set', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'touch zz' }, ...sub })
  let b = await read('blocked')
  assert.deepEqual([b.tool, b.command, b.agentId], ['Bash', 'touch zz', sub.agent_id])
  run('set', 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  b = await read('blocked')
  assert.deepEqual([b.tool, b.command, b.agentId], ['Bash', 'touch zz', sub.agent_id], 'the notification must not downgrade it to the parent\'s Agent call')

  // A parallel agent's tool call, the parent's own tool call, and the parent's Stop leave it standing.
  run('resume', 'PreToolUse', { tool_name: 'Read', agent_id: 'other-agent-1', agent_type: 'Explore' })
  run('resume', 'PreToolUse', { tool_name: 'Read' })
  run('idle', 'Stop')
  run('idle', 'SubagentStop', { ...sub })
  assert.equal((await read('blocked')).agentId, sub.agent_id)
  assert.equal((await read('working')).state, 'idle') // parent's own turn did end

  // Answered: that agent's next tool call clears it.
  run('resume', 'PreToolUse', { tool_name: 'Bash', ...sub })
  assert.equal(await read('blocked'), null)

  // Subagent stopping while its prompt is pending also clears it; another agent's stop does not.
  run('set', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' }, ...sub })
  run('agentstop', 'SubagentStop', { agent_id: 'other-agent-1' })
  assert.ok(await read('blocked'))
  run('agentstop', 'SubagentStop', { ...sub })
  assert.equal(await read('blocked'), null)

  // A main-thread prompt is not cleared by a subagent's tool call, but is by the parent's.
  run('set', 'PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/a' } })
  run('resume', 'PreToolUse', { tool_name: 'Read', ...sub })
  assert.equal((await read('blocked')).tool, 'Write')
  run('resume', 'PreToolUse', { tool_name: 'Read' })
  assert.equal(await read('blocked'), null)
})

test('a bare Notification from a subagent reads the subagent\'s own transcript for the command', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-hook-'))
  const tp = path.join(dir, `${ID}.jsonl`)
  await fsp.mkdir(path.join(dir, ID, 'subagents'), { recursive: true })
  await fsp.writeFile(path.join(dir, ID, 'subagents', 'agent-abc123def.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'rm -rf build' } }] } }) + '\n')
  const m = await buildMarker({ session_id: ID, transcript_path: tp, agent_id: 'abc123def', agent_type: 'Explore', message: 'Claude needs your permission' }, 5)
  assert.deepEqual([m.tool, m.command, m.agentId, m.agentType], ['Bash', 'rm -rf build', 'abc123def', 'Explore'])
})

// --- question detection (a turn that ends on a question for the user) ---

const jl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n')
const asst = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
const userText = (text) => ({ type: 'user', message: { role: 'user', content: text } })
const toolResult = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const wrap = (id, input) => ({ type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up', input })

test('askedQuestion: wrap_up with an ask is a question, even with the result and a closing message after it', () => {
  const t = jl(
    userText('do the thing'),
    asst(wrap('w1', { recap: 'Done.', ask: 'Ship it?', actions: [{ label: 'Yes' }] })),
    toolResult('w1'),
    asst({ type: 'text', text: 'All done, see above.' }),
  )
  assert.deepEqual(askedQuestion(t), { tool: 'mcp__ccd_turn__wrap_up', ask: 'Ship it?' })
})

test('askedQuestion: wrap_up with only a recap asks nothing', () => {
  assert.equal(askedQuestion(jl(userText('go'), asst(wrap('w1', { recap: 'Done.' })), toolResult('w1'))), null)
  assert.equal(askedQuestion(jl(userText('go'), asst(wrap('w1', { recap: 'Done.', ask: '   ' })))), null)
})

test('askedQuestion: an unanswered AskUserQuestion counts, an answered one does not', () => {
  const ask = { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [{ label: 'PG' }, { label: 'SQLite' }] }] } }
  const got = askedQuestion(jl(userText('go'), asst(ask)))
  assert.equal(got.tool, 'AskUserQuestion')
  assert.match(got.ask, /Which DB\?/)
  assert.equal(askedQuestion(jl(userText('go'), asst(ask), toolResult('q1'), asst({ type: 'text', text: 'Using PG.' }))), null)
})

test('askedQuestion: an older wrap_up followed by a user message and a plain turn is not a question', () => {
  const t = jl(
    userText('go'),
    asst(wrap('w1', { recap: 'r', ask: 'Ship it?' })),
    toolResult('w1'),
    userText('yes'),
    asst({ type: 'text', text: 'Shipped.' }),
  )
  assert.equal(askedQuestion(t), null)
  // and the user's reply right after the question clears it too
  assert.equal(askedQuestion(jl(asst(wrap('w1', { ask: 'Ship it?' })), toolResult('w1'), userText('yes'))), null)
  assert.equal(askedQuestion(jl(asst(wrap('w1', { ask: 'Ship it?' })), toolResult('w1'), { type: 'user', message: { content: [{ type: 'text', text: 'yes' }] } })), null)
})

test('askedQuestion: another tool call after the wrap_up, or a different last tool, is not a question', () => {
  const bash = { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }
  assert.equal(askedQuestion(jl(userText('go'), asst(wrap('w1', { ask: 'Ship it?' })), toolResult('w1'), asst(bash))), null)
})

test('askedQuestion: meta and sidechain records are ignored; partial or junk lines never throw', () => {
  const t = jl(asst(wrap('w1', { ask: 'Ship it?' })), toolResult('w1'), { type: 'user', isMeta: true, message: { content: 'system reminder' } }, { ...asst({ type: 'tool_use', id: 's1', name: 'Bash', input: {} }), isSidechain: true })
  assert.equal(askedQuestion(t)?.ask, 'Ship it?')
  assert.deepEqual(askedQuestion(t + '\n{"type":"assistant","message":{"cont'), askedQuestion(t))
  assert.deepEqual(askedQuestion('garbage\n{"type":"user"'), null)
  assert.equal(askedQuestion(''), null)
  assert.equal(askedQuestion(null), null)
})

test('buildQuestionMarker is a blocked marker of kind question, and parseMarker keeps the kind', () => {
  const m = buildQuestionMarker({ session_id: ID, cwd: '/r', transcript_path: '/t.jsonl' }, { tool: 'x', ask: 'Ship it?' }, 7)
  const p = parseMarker(m)
  assert.equal(p.kind, 'question')
  assert.equal(p.command, 'Ship it?')
  assert.equal(p.tool, '')
  assert.equal(p.message, 'Waiting for your answer')
  assert.equal(parseMarker({ sessionId: ID, at: 5 }).kind, 'permission')
})
