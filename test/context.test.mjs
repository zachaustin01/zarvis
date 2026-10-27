import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { contextWindow, lastUsageTokens, ctxView, compactTokens, contextTokens, contextOf, DEFAULT_WINDOW, AMBER_PCT, RED_PCT } from '../lib/context.mjs'

const asst = (usage, extra = {}) => JSON.stringify({ type: 'assistant', message: { model: 'claude-test', usage, ...extra.message }, ...extra.top })
const use = (i, r, c, o = 5) => ({ input_tokens: i, cache_read_input_tokens: r, cache_creation_input_tokens: c, output_tokens: o })

test('contextWindow: a positive integer from the environment, else the default', () => {
  assert.equal(contextWindow({}), DEFAULT_WINDOW)
  assert.equal(contextWindow({ ZARVIS_CONTEXT_WINDOW: '200000' }), 200000)
  assert.equal(contextWindow({ ZARVIS_CONTEXT_WINDOW: ' 500000 ' }), 500000)
  for (const bad of ['0', '-5', '1.5', 'abc', '', '1e6', '99999999999999999999']) assert.equal(contextWindow({ ZARVIS_CONTEXT_WINDOW: bad }), DEFAULT_WINDOW, bad)
})

test('lastUsageTokens: input + cache read + cache creation of the last real assistant record', () => {
  const tail = [asst(use(10, 1000, 200)), JSON.stringify({ type: 'user' }), asst(use(3, 80000, 500, 900))].join('\n')
  assert.equal(lastUsageTokens(tail), 80503) // output tokens are not context
})

test('lastUsageTokens skips sidechains, synthetic records and a partial first line; none yet is null, never 0', () => {
  const tail = ['{"partial":', asst(use(1, 50000, 0)), asst(use(1, 99999, 0), { top: { isSidechain: true } }), asst(use(1, 77777, 0), { message: { model: '<synthetic>' } })].join('\n')
  assert.equal(lastUsageTokens(tail), 50001)
  assert.equal(lastUsageTokens(''), null)
  assert.equal(lastUsageTokens('{"type":"user"}\nnot json'), null)
  assert.equal(lastUsageTokens(asst(use(0, 0, 0))), null) // all zeros is "no usage yet", not 0%
  assert.equal(lastUsageTokens(asst({ input_tokens: 'x' })), null)
})

test('compaction: the last record wins, so usage simply drops', () => {
  assert.equal(lastUsageTokens([asst(use(1, 300000, 0)), asst(use(1, 20000, 0))].join('\n')), 20001)
})

test('ctxView: integer percent of the reference window, amber from 70, red from 90, nothing for no tokens', () => {
  assert.equal(ctxView(0), null)
  assert.equal(ctxView(null), null)
  assert.deepEqual(ctxView(235_000), { tokens: 235_000, window: 1_000_000, pct: 24, level: '', label: '235k', winLabel: '1M' })
  assert.equal(ctxView(AMBER_PCT * 10_000).level, 'amber')
  assert.equal(ctxView(AMBER_PCT * 10_000 - 1).level, '')
  assert.equal(ctxView(RED_PCT * 10_000).level, 'red')
  assert.equal(ctxView(150_000, 200_000).pct, 75)
  assert.equal(ctxView(300_000, 200_000).pct, 150) // a small reference can pass 100; shown as is, never clamped
})

test('compactTokens', () => {
  assert.equal(compactTokens(950), '950')
  assert.equal(compactTokens(235_400), '235k')
  assert.equal(compactTokens(1_000_000), '1M')
  assert.equal(compactTokens(1_250_000), '1.3M')
})

test('contextTokens reads a temp transcript tail, caches by mtime+size, and survives missing files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zarvis-ctx-'))
  const file = path.join(dir, 'fixture.jsonl')
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } })
  await fsp.writeFile(file, `${asst(use(1, 11111, 0))}\n${filler}\n`)
  assert.equal(await contextTokens(file), 11112)
  await fsp.writeFile(file, `${asst(use(1, 11111, 0))}\n${filler}\n${asst(use(1, 22222, 0))}\n`)
  assert.equal(await contextTokens(file), 22223) // changed size: re-read
  const big = path.join(dir, 'big.jsonl') // usage only in the head; the tail window has none
  await fsp.writeFile(big, `${asst(use(1, 5, 0))}\n${(filler + '\n').repeat(400)}`)
  assert.equal(await contextTokens(big), null)
  assert.equal(await contextTokens(path.join(dir, 'missing.jsonl')), null)
  assert.equal(await contextTokens(''), null)
  assert.deepEqual(await contextOf(file, 100_000), { tokens: 22223, window: 100_000, pct: 22, level: '', label: '22k', winLabel: '100k' })
  assert.equal(await contextOf(path.join(dir, 'missing.jsonl')), null)
  await fsp.rm(dir, { recursive: true })
})
