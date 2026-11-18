import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { firstPrompt, lastReply, promptsOf } from '../lib/prompts.mjs'
import { buildLookup } from '../lib/lookup.mjs'
import { runRoster, parseArgs, searchEntries } from '../lib/roster-cli.mjs'
import { scoreSession, fuzzy } from '../public/palette.js'

const jl = (...rs) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n'
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra })
const asst = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content }, ...extra })

test('firstPrompt: the first real user turn; skips system-added turns, tool results and sidechains', () => {
  const head = jl(
    user('<system-reminder>ide</system-reminder>'),
    user([{ type: 'text', text: 'side' }], { isSidechain: true }),
    user([{ type: 'tool_result', content: 'x' }], { toolUseResult: {} }),
    user([{ type: 'text', text: 'Fix the   Dagster\nretry bug' }]),
    user('second prompt'),
  )
  assert.equal(firstPrompt(head), 'Fix the Dagster retry bug')
  assert.equal(firstPrompt('not json\n'), '')
})

test('lastReply: last assistant text, skipping tool-only turns and a partial first line', () => {
  const tail = 'partial{"junk' + '\n' + jl(asst([{ type: 'text', text: 'older' }]), asst([{ type: 'text', text: 'Done: merged' }]), asst([{ type: 'tool_use', name: 'Bash' }]))
  assert.equal(lastReply(tail), 'Done: merged')
  assert.equal(lastReply(jl(user('hi'))), '')
})

test('promptsOf reads head and tail of a file, caches by mtime+size, and is empty for a missing file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zv-'))
  const f = path.join(dir, 't.jsonl')
  await fsp.writeFile(f, jl(user('first ask'), asst([{ type: 'text', text: 'reply one' }])))
  assert.deepEqual(await promptsOf(f), { prompt: 'first ask', reply: 'reply one' })
  await fsp.appendFile(f, jl(asst([{ type: 'text', text: 'reply two' }])))
  assert.equal((await promptsOf(f)).reply, 'reply two')
  assert.deepEqual(await promptsOf(path.join(dir, 'nope.jsonl')), { prompt: '', reply: '' })
  await fsp.rm(dir, { recursive: true })
})

test('promptsOf extracts prompt and reply from Antigravity user and swarm worker transcripts', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zv-ag-prompts-'))
  try {
    const userTr = path.join(dir, 'user.jsonl')
    await fsp.writeFile(
      userTr,
      jl(
        {
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: '<USER_REQUEST>\nInvestigate the   Dagster\nqueue latency\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>',
        },
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: '',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: 'Done: latency reduced\nby 40%',
        },
      ),
    )
    assert.deepEqual(await promptsOf(userTr), {
      prompt: 'Investigate the Dagster queue latency',
      reply: 'Done: latency reduced by 40%',
    })

    const swarmTr = path.join(dir, 'swarm.jsonl')
    await fsp.writeFile(
      swarmTr,
      jl(
        {
          step_index: 0,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T15:45:46Z sender=63528f3d-7f1f-4413-ba1b-458118da5dd0 priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #4\n</SYSTEM_MESSAGE>',
        },
        {
          step_index: 1,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T15:45:46Z sender=a6705c08-76fd-4101-825e-748758a3028c priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #4 for @packet-loa-1035-probe):\n\nYou own the deep-dive verification of **ONYX-50676**.\n</SYSTEM_MESSAGE>',
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: 'Verified ONYX-50676 packet alignment.',
        },
      ),
    )
    assert.deepEqual(await promptsOf(swarmTr), {
      prompt: 'You own the deep-dive verification of **ONYX-50676**.',
      reply: 'Verified ONYX-50676 packet alignment.',
    })
  } finally {
    await fsp.rm(dir, { recursive: true })
  }
})

test('palette scoring: prompt text matches contiguous words only, and 1-2 character tokens skip it', () => {
  const r = { sessionId: 'a', name: 'zebra', role: 'worker', state: 'idle', prompt: 'Fix the Dagster retry bug in the ingest job', reply: '' }
  assert.ok(scoreSession('dagster retry', r))
  assert.equal(scoreSession('dgstr', r), null) // scattered letters across prose do not count
  assert.equal(scoreSession('ig', r), null)
  assert.ok(scoreSession('zbr', r)) // names stay fuzzy
  assert.equal(fuzzy('dgstr', 'dagster', { contiguous: true }), null)
})

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`
const NOW = 1_800_000_000_000
const rec = (n) => ({ sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `Title ${n}`, cwd: `/work/p${n}`, branch: `b${n}`, lastActivityAt: NOW - 60_000 })
const world = () => ({
  records: [rec(1), rec(2), rec(3)],
  state: { overlays: {}, roles: {}, parked: {}, done: {} },
  roles: { [id(1)]: { role: 'worker' }, [id(2)]: { role: 'worker' }, [id(3)]: { role: 'worker' } },
  markers: [], working: [], tasks: {}, now: NOW, branchOf: async () => '',
  textOf: async (sid) => ({ [id(1)]: { prompt: 'Fix the Dagster retry bug', reply: 'pushed' }, [id(2)]: { prompt: 'Write the billing report', reply: 'the dagster run is green' } }[sid] || { prompt: '', reply: '' }),
})

test('buildLookup adds prompt and reply only when textOf is given', async () => {
  const list = await buildLookup(world())
  assert.equal(list.find((e) => e.sessionId === id(1)).prompt, 'Fix the Dagster retry bug')
  const { textOf, ...bare } = world()
  assert.equal('prompt' in (await buildLookup(bare))[0], false)
})

test('roster --query finds sessions by first prompt or last reply, best match first, and shows what they were asked', async () => {
  assert.equal(parseArgs(['list', '--query', 'dagster retry']).query, 'dagster retry')
  const entries = await buildLookup(world())
  assert.deepEqual(searchEntries(entries, 'dagster').map((e) => e.sessionId), [id(1), id(2)]) // asked beats mentioned
  assert.deepEqual(searchEntries(entries, 'dagster billing').map((e) => e.sessionId), [id(2)]) // every word must hit, across prompt and reply
  assert.deepEqual(searchEntries(entries, 'dagster pushed billing').map((e) => e.sessionId), [])
  const out = []
  assert.equal(await runRoster(['list', '--query', 'billing report'], { deps: world(), now: NOW, log: (s) => out.push(s) }), 0)
  assert.equal(out.length, 1)
  assert.match(out[0], /Title 2/)
  assert.match(out[0], /asked: Write the billing report/)
  const none = []
  await runRoster(['list', '--query', 'zzzzzz'], { deps: world(), now: NOW, log: (s) => none.push(s) })
  assert.deepEqual(none, ['no matching sessions'])
})
