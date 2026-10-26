import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import {
  guard,
  guardPost,
  releaseSession,
  claimManual,
  claimView,
  readClaim,
  readClaims,
  createClaim,
  claimId,
  claimsDir,
  holderLive,
  findRoot,
  readBranch,
  labelFor,
  jiraKey,
  gitInvocations,
  isWholeTree,
  touchedRoots,
  sessionProcess,
  findClaudeAncestor,
  realDeps,
  parseClaim,
  STALE_MS,
} from '../lib/claims.mjs'
import { runClaims } from '../lib/claims-cli.mjs'
import { renderRoster } from '../lib/roster.mjs'

const HOOK = fileURLToPath(new URL('../hooks/zarvis-hook.mjs', import.meta.url))
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url))
const sid = (c) => `${c.repeat(8)}-0000-4000-8000-000000000000`
const A = sid('a')
const B = sid('b')
const C = sid('c')
const NOW = 1_800_000_000_000
const MIN = 60_000

const tmp = (p = 'zarvis-claims-') => fs.mkdtempSync(path.join(os.tmpdir(), p))

/** A fake checkout: a directory with .git/HEAD on `branch` (or detached at `sha`). */
function repo(branch = 'main', { sha } = {}) {
  const dir = fs.realpathSync(tmp('zarvis-repo-'))
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), sha ? `${sha}\n` : `ref: refs/heads/${branch}\n`)
  fs.mkdirSync(path.join(dir, 'src'))
  return dir
}

/** Fake processes: pid per session, which pids are alive, and each pid's start time. */
function world() {
  const home = tmp('zarvis-home-')
  const pid = { [A]: 101, [B]: 202, [C]: 303 }
  const alive = new Set(Object.values(pid))
  const started = {}
  const deps = { kill: (p) => alive.has(p), lstart: (p) => started[p] ?? `start-${p}` }
  const ctx = (who, now = NOW) => ({
    home,
    now,
    deps,
    self: () => ({ pid: pid[who], pidStart: `start-${pid[who]}` }),
    name: (s) => `name-${s[0]}`,
  })
  return { home, pid, alive, started, deps, ctx }
}

const edit = (who, file, extra = {}) => ({ session_id: who, cwd: path.dirname(file), tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, ...extra })
const bash = (who, command, cwd, extra = {}) => ({ session_id: who, cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, ...extra })
const claimOf = (w, root) => readClaim(path.join(claimsDir(w.home), `${claimId(root)}.json`))
const ask = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })

// --- claiming ---

test('a first write claims the checkout, labelled with the branch', () => {
  const w = world()
  const r = repo('main')
  assert.equal(guard(edit(A, path.join(r, 'src', 'new-file.js')), w.ctx(A)), null)
  const c = claimOf(w, r)
  assert.deepEqual([c.root, c.label, c.labelKind, c.branch], [r, 'main', 'branch', 'main'])
  assert.deepEqual(c.holder, { sessionId: A, pid: 101, pidStart: 'start-101', name: 'name-a', since: NOW, lastWrite: NOW })
  assert.deepEqual([c.shared, c.pending], [[], {}])
  assert.equal(path.basename((readClaims(w.home))[0].file), `${claimId(r)}.json`)
})

test('Write, MultiEdit and NotebookEdit claim too; a read does not; a file outside any checkout does not', () => {
  const w = world()
  const r = repo()
  const outside = tmp('zarvis-outside-')
  assert.equal(guard({ ...edit(A, path.join(r, 'a.js')), tool_name: 'Read' }, w.ctx(A)), null)
  assert.equal(readClaims(w.home).length, 0)
  assert.equal(guard(edit(A, path.join(outside, 'x.js')), w.ctx(A)), null)
  assert.equal(readClaims(w.home).length, 0)
  for (const [tool, key] of [['Write', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']]) {
    assert.equal(touchedRoots({ cwd: r, tool_name: tool, tool_input: { [key]: path.join(r, 'x') } })[0].root, r)
  }
})

test('git commands claim: plain, git -C from elsewhere, chained, env prefixed', () => {
  const w = world()
  const [r1, r2, r3] = [repo(), repo(), repo()]
  const away = tmp('zarvis-away-')
  assert.equal(guard(bash(A, 'git status', r1), w.ctx(A)), null)
  assert.equal(claimOf(w, r1).holder.sessionId, A)
  assert.equal(guard(bash(A, `git -C ${r2} log --oneline`, away), w.ctx(A)), null)
  assert.equal(claimOf(w, r2).holder.sessionId, A)
  assert.equal(guard(bash(A, 'npm test && FOO=1 git diff | head', r3), w.ctx(A)), null)
  assert.equal(claimOf(w, r3).holder.sessionId, A)
  assert.deepEqual(readClaims(w.home).length, 3)
  const none = repo()
  assert.equal(guard(bash(A, 'npm test; echo "git status"; ls', none), w.ctx(A)), null)
  assert.equal(claimOf(w, none), null, 'git inside an echo string, or no git at all, is not a git command')
})

test('gitInvocations: the shell forms it understands, and the directory each runs in', () => {
  const g = (cmd, cwd = '/w') => gitInvocations(cmd, cwd).map((i) => [i.dir, i.sub])
  assert.deepEqual(g('git status'), [['/w', 'status']])
  assert.deepEqual(g('cd x && git add -A; git commit -m "a && git push"'), [['/w', 'add'], ['/w', 'commit']])
  assert.deepEqual(g('git -C /other -c core.x=1 --no-pager log'), [['/other', 'log']])
  assert.deepEqual(g('git -C sub -C deeper pull', '/w'), [['/w/sub/deeper', 'pull']])
  assert.deepEqual(g('echo $(git rev-parse HEAD) && /usr/bin/git fetch'), [['/w', 'rev-parse'], ['/w', 'fetch']])
  assert.deepEqual(g('sudo git clean -fd'), [['/w', 'clean']])
  assert.deepEqual(g('gitk && digit status && echo git'), [])
  assert.deepEqual(g('git'), [])
})

test('Jira key from the branch name, uppercased; otherwise the branch; a detached HEAD labels as detached@sha', () => {
  assert.deepEqual(labelFor('feature/proj-123-add-thing'), { label: 'PROJ-123', labelKind: 'jira' })
  assert.deepEqual(labelFor('ab2-7'), { label: 'AB2-7', labelKind: 'jira' })
  assert.deepEqual(labelFor('main'), { label: 'main', labelKind: 'branch' })
  assert.deepEqual(labelFor('main', 'PROJ-9'), { label: 'PROJ-9', labelKind: 'manual' })
  assert.equal(jiraKey('x'), '')
  const w = world()
  const key = repo('ZED-42-fix')
  guard(edit(A, path.join(key, 'a')), w.ctx(A))
  assert.deepEqual([claimOf(w, key).label, claimOf(w, key).labelKind], ['ZED-42', 'jira'])
  const det = repo('x', { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' })
  assert.equal(readBranch(det), 'detached@a1b2c3d')
  guard(edit(A, path.join(det, 'a')), w.ctx(A))
  assert.deepEqual([claimOf(w, det).label, claimOf(w, det).branch], ['detached@a1b2c3d', 'detached@a1b2c3d'])
})

test('a linked worktree (.git is a file) is its own checkout, and its branch is read through the gitdir', () => {
  const main = repo('main')
  const gitdir = path.join(main, '.git', 'worktrees', 'wt')
  fs.mkdirSync(gitdir, { recursive: true })
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/proj-5-wt\n')
  const wt = fs.realpathSync(tmp('zarvis-wt-'))
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`)
  fs.mkdirSync(path.join(wt, 'deep', 'er'), { recursive: true })
  assert.equal(findRoot(path.join(wt, 'deep', 'er', 'file.js')), wt)
  assert.equal(readBranch(wt), 'proj-5-wt')
  const w = world()
  guard(edit(A, path.join(wt, 'deep', 'er', 'f')), w.ctx(A))
  guard(edit(B, path.join(main, 'src', 'f')), w.ctx(B))
  assert.deepEqual([claimOf(w, wt).holder.sessionId, claimOf(w, main).holder.sessionId], [A, B], 'two checkouts, no conflict')
  assert.equal(claimOf(w, wt).label, 'PROJ-5')
})

test('claim <KEY> overrides the label; later branch changes keep a manual label but refresh an automatic one', () => {
  const w = world()
  const r = repo('main')
  assert.deepEqual(claimManual(r, 'proj-77', A, w.ctx(A)), { action: 'claimed', root: r, label: 'PROJ-77' })
  assert.deepEqual([claimOf(w, r).label, claimOf(w, r).labelKind], ['PROJ-77', 'manual'])
  fs.writeFileSync(path.join(r, '.git', 'HEAD'), 'ref: refs/heads/other-2-x\n')
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  assert.deepEqual([claimOf(w, r).label, claimOf(w, r).branch], ['PROJ-77', 'other-2-x'])
  const r2 = repo('main')
  guard(edit(A, path.join(r2, 'a')), w.ctx(A))
  fs.writeFileSync(path.join(r2, '.git', 'HEAD'), 'ref: refs/heads/zz-9-y\n')
  guard(edit(A, path.join(r2, 'a')), w.ctx(A))
  assert.equal(claimOf(w, r2).label, 'ZZ-9')
  assert.throws(() => claimManual(r, 'bad key!', A, w.ctx(A)), /Jira key/)
})

// --- conflicts, sharing ---

test('another live session holding the checkout gets an ask naming the holder, with the exact JSON shape', () => {
  const w = world()
  const r = repo('feature/proj-1-x')
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  const out = guard(edit(B, path.join(r, 'b')), w.ctx(B, NOW + 5 * MIN))
  assert.deepEqual(
    out,
    ask(`Zarvis: ${r} is claimed by “name-a” (PROJ-1, branch feature/proj-1-x; last write 5m ago). Allow = share this checkout (while shared, whole-tree git such as add -A, commit -a, stash, checkout or reset asks every time).`),
  )
  assert.equal(JSON.parse(JSON.stringify(out)).hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(claimOf(w, r).holder.sessionId, A, 'the holder is unchanged')
})

test('an allowed ask joins the sharers through the PostToolUse tool_use_id; after that nothing asks', () => {
  const w = world()
  const r = repo()
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  const pre = edit(B, path.join(r, 'b'), { tool_use_id: 'toolu_allow' })
  assert.ok(guard(pre, w.ctx(B)))
  assert.deepEqual(claimOf(w, r).pending, { [B]: 'toolu_allow' })
  guardPost({ ...pre, hook_event_name: 'PostToolUse' }, w.ctx(B, NOW + 1000))
  const c = claimOf(w, r)
  assert.deepEqual(c.shared, [{ sessionId: B, name: 'name-b', since: NOW + 1000 }])
  assert.deepEqual(c.pending, {})
  assert.equal(guard(edit(B, path.join(r, 'c')), w.ctx(B)), null)
  assert.equal(guard(edit(A, path.join(r, 'd')), w.ctx(A)), null)
  assert.ok(guard(edit(C, path.join(r, 'e')), w.ctx(C)), 'a third session still asks')
})

test('a Pre with no Post (denied or aborted) leaves nothing shared and asks again; a different tool_use_id does not join', () => {
  const w = world()
  const r = repo()
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  const pre = edit(B, path.join(r, 'b'), { tool_use_id: 'toolu_one' })
  assert.ok(guard(pre, w.ctx(B)))
  assert.deepEqual(claimOf(w, r).shared, [])
  assert.ok(guard(edit(B, path.join(r, 'b'), { tool_use_id: 'toolu_two' }), w.ctx(B)))
  guardPost({ ...pre, tool_use_id: 'toolu_one' }, w.ctx(B)) // the first one's Post arrives late: it was replaced by toolu_two
  assert.deepEqual(claimOf(w, r).shared, [])
})

test('whole-tree git while shared asks every time, for the holder and the sharer; a plain git status and plain git before sharing do not', () => {
  const w = world()
  const r = repo()
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  assert.equal(guard(bash(A, 'git add -A', r), w.ctx(A)), null, 'not shared yet: nothing to sweep')
  const pre = edit(B, path.join(r, 'b'), { tool_use_id: 'toolu_x' })
  guard(pre, w.ctx(B))
  guardPost(pre, w.ctx(B))
  for (const who of [A, B]) {
    for (const cmd of ['git add -A', 'git add .', 'git add -u', 'git commit -am "x"', 'git stash', 'git checkout main', 'git switch -c x', 'git reset --hard', 'git restore .', 'git clean -fd', 'git rebase main', 'git merge x', 'git cherry-pick abc', 'git pull']) {
      const out = guard(bash(who, cmd, r), w.ctx(who))
      assert.ok(out, `${who === A ? 'holder' : 'sharer'}: ${cmd} should ask`)
      assert.equal(out.hookSpecificOutput.permissionDecision, 'ask')
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /whole-tree git/)
    }
    for (const cmd of ['git status', 'git diff', 'git add src/a.js', 'git commit -m x', 'git restore src/a.js', 'git log -a', 'git commit -m "add -a"']) {
      assert.equal(guard(bash(who, cmd, r), w.ctx(who)), null, cmd)
    }
  }
})

test('isWholeTree classification', () => {
  const t = (line) => {
    const [i] = gitInvocations(line, '/w')
    return isWholeTree(i.sub, i.args)
  }
  assert.equal(t('git add --all'), true)
  assert.equal(t('git add -Av'), true)
  assert.equal(t('git add :/'), true)
  assert.equal(t('git add a.js b.js'), false)
  assert.equal(t('git commit --all -m x'), true)
  assert.equal(t('git commit -m x -a'), true)
  assert.equal(t('git commit -F msg.txt'), false)
  assert.equal(t('git restore --staged .'), true)
  assert.equal(t('git push'), false)
  assert.equal(t('git fetch'), false)
})

// --- takeover ---

test('takeover: a dead holder pid, a reused pid (start time differs), eight idle hours, and a released claim', () => {
  const w = world()
  const r = repo()
  const hold = () => guard(edit(A, path.join(r, 'a')), w.ctx(A))
  const other = (now = NOW + MIN) => guard(edit(B, path.join(r, 'b')), w.ctx(B, now))

  hold()
  assert.ok(other(), 'live holder: ask')

  w.alive.delete(w.pid[A])
  assert.equal(other(), null, 'dead pid: taken over silently')
  assert.equal(claimOf(w, r).holder.sessionId, B)
  assert.equal(claimOf(w, r).holder.since, NOW + MIN)

  fs.rmSync(path.join(claimsDir(w.home), `${claimId(r)}.json`))
  w.alive.add(w.pid[A])
  hold()
  w.started[w.pid[A]] = 'a different start time' // the pid now belongs to someone else
  assert.equal(other(), null, 'pid reuse: taken over')
  assert.equal(claimOf(w, r).holder.sessionId, B)

  fs.rmSync(path.join(claimsDir(w.home), `${claimId(r)}.json`))
  delete w.started[w.pid[A]]
  hold()
  assert.ok(other(NOW + STALE_MS - MIN), 'just under 8h: still held')
  assert.equal(other(NOW + STALE_MS + MIN), null, 'over 8h without a write: taken over')
  assert.equal(claimOf(w, r).holder.sessionId, B)

  assert.deepEqual(releaseSession(w.home, B), [r])
  assert.equal(claimOf(w, r), null)
  assert.equal(guard(edit(A, path.join(r, 'c')), w.ctx(A, NOW + 2 * MIN)), null)
  assert.equal(claimOf(w, r).holder.sessionId, A, 'free again after release')
})

test('a sharer takes over from a dead holder with a cheap check; a live holder does not spawn lstart for the sharer', () => {
  const w = world()
  const r = repo()
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  const pre = edit(B, path.join(r, 'b'), { tool_use_id: 'toolu_s' })
  guard(pre, w.ctx(B))
  guardPost(pre, w.ctx(B))
  let spawned = 0
  const ctx = w.ctx(B)
  ctx.deps = { kill: w.deps.kill, lstart: () => (spawned++, 'x') }
  assert.equal(guard(edit(B, path.join(r, 'c')), ctx), null)
  assert.equal(spawned, 0)
  w.alive.delete(w.pid[A])
  assert.equal(guard(edit(B, path.join(r, 'c')), w.ctx(B)), null)
  assert.equal(claimOf(w, r).holder.sessionId, B)
  assert.deepEqual(claimOf(w, r).shared, [])
})

test('the holder refreshes lastWrite at most once a minute', () => {
  const w = world()
  const r = repo()
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  const file = path.join(claimsDir(w.home), `${claimId(r)}.json`)
  guard(edit(A, path.join(r, 'a')), w.ctx(A, NOW + 59_000))
  assert.equal(readClaim(file).holder.lastWrite, NOW)
  guard(edit(A, path.join(r, 'a')), w.ctx(A, NOW + 61_000))
  assert.equal(readClaim(file).holder.lastWrite, NOW + 61_000)
})

test('a subagent call counts as its parent: no conflict with it, and its ask is the parent\'s', () => {
  const w = world()
  const r = repo()
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  assert.equal(guard(edit(A, path.join(r, 'b'), { agent_id: 'agent-1', agent_type: 'general-purpose' }), w.ctx(A)), null)
  assert.equal(claimOf(w, r).holder.sessionId, A)
  const sub = edit(B, path.join(r, 'c'), { agent_id: 'agent-2', tool_use_id: 'toolu_sub' })
  assert.ok(guard(sub, w.ctx(B)))
  guardPost(sub, w.ctx(B))
  assert.deepEqual(claimOf(w, r).shared.map((s) => s.sessionId), [B])
})

test('SessionEnd releases what the session holds and leaves what it shares', () => {
  const w = world()
  const [r1, r2] = [repo(), repo()]
  guard(edit(A, path.join(r1, 'a')), w.ctx(A))
  guard(edit(A, path.join(r2, 'a')), w.ctx(A))
  guard(edit(B, path.join(r1, 'a')), w.ctx(B)) // asks; B's pending is recorded
  const pre = edit(B, path.join(r1, 'b'), { tool_use_id: 'toolu_j' })
  guard(pre, w.ctx(B))
  guardPost(pre, w.ctx(B))
  assert.deepEqual(releaseSession(w.home, B), [r1])
  assert.deepEqual(claimOf(w, r1).shared, [])
  assert.deepEqual(claimOf(w, r1).pending, {})
  assert.deepEqual(releaseSession(w.home, A).sort(), [r1, r2].sort())
  assert.equal(readClaims(w.home).length, 0)
  assert.deepEqual(releaseSession(w.home, 'not a session id!'), [])
})

test('liveness: unknown pid is live until stale; a ps that fails does not kill a claim', () => {
  const claim = { holder: { pid: 0, pidStart: '', lastWrite: NOW } }
  assert.equal(holderLive(claim, NOW + MIN, { kill: () => false, lstart: () => null }), true)
  assert.equal(holderLive(claim, NOW + STALE_MS + 1, { kill: () => true, lstart: () => null }), false)
  assert.equal(holderLive({ holder: { pid: 5, pidStart: 's', lastWrite: NOW } }, NOW, { kill: () => true, lstart: () => null }), true)
})

test('real process: a claim whose holder is a child we kill is taken over (real kill and ps)', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  const w = world()
  const r = repo()
  const pidStart = realDeps.lstart(child.pid)
  assert.ok(pidStart, 'ps reports a start time for a live process')
  const ctxFor = (who) => ({ home: w.home, now: Date.now(), deps: realDeps, self: () => (who === A ? { pid: child.pid, pidStart } : { pid: process.pid, pidStart: realDeps.lstart(process.pid) }), name: () => who })
  assert.equal(guard(edit(A, path.join(r, 'a')), ctxFor(A)), null)
  assert.ok(guard(edit(B, path.join(r, 'b')), ctxFor(B)), 'the live child holds it')
  child.kill('SIGKILL')
  await once(child, 'exit')
  assert.equal(guard(edit(B, path.join(r, 'b')), ctxFor(B)), null)
  assert.equal(claimOf(w, r).holder.sessionId, B)
})

// --- storage ---

test('two exclusive creators: exactly one wins, in-process and across real processes', async () => {
  const w = world()
  const r = repo()
  const file = path.join(claimsDir(w.home), `${claimId(r)}.json`)
  const mk = (who) => ({ v: 1, root: r, label: 'main', labelKind: 'branch', branch: 'main', holder: { sessionId: who, pid: 1, pidStart: '', name: '', since: NOW, lastWrite: NOW }, shared: [], pending: {} })
  assert.deepEqual([createClaim(file, mk(A)), createClaim(file, mk(B))], [true, false])
  assert.equal(readClaim(file).holder.sessionId, A)

  const home = tmp('zarvis-race-')
  const f2 = path.join(claimsDir(home), `${claimId(r)}.json`)
  const code = `import { createClaim } from ${JSON.stringify(new URL('../lib/claims.mjs', import.meta.url).href)}
process.stdout.write(String(createClaim(${JSON.stringify(f2)}, { v: 1, root: ${JSON.stringify(r)}, holder: { sessionId: process.argv[1] } })))`
  const runs = await Promise.all(
    ['a', 'b', 'c', 'd', 'e', 'f'].map(async (c) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', code, sid(c)], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      await once(p, 'close')
      return out
    }),
  )
  assert.equal(runs.filter((o) => o === 'true').length, 1)
  assert.equal(runs.filter((o) => o === 'false').length, 5)
})

test('parseClaim and readClaims drop junk and cap sizes', () => {
  const w = world()
  const r = repo()
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  fs.writeFileSync(path.join(claimsDir(w.home), '0123456789abcdef.json'), '{nope')
  fs.writeFileSync(path.join(claimsDir(w.home), 'fedcba9876543210.json'), JSON.stringify(readClaim(path.join(claimsDir(w.home), `${claimId(r)}.json`))))
  fs.writeFileSync(path.join(claimsDir(w.home), 'notes.txt'), 'x')
  assert.equal(readClaims(w.home).length, 1, 'bad JSON and a file whose name does not match its root are skipped')
  assert.equal(readClaims(path.join(w.home, 'missing')).length, 0)
  assert.equal(parseClaim({ v: 2 }), null)
  assert.equal(parseClaim({ v: 1, root: 'rel', holder: { sessionId: A } }), null)
  const big = parseClaim({ v: 1, root: '/x', label: 'L'.repeat(900), holder: { sessionId: A, name: 'N'.repeat(900) }, shared: Array.from({ length: 80 }, () => ({ sessionId: B, name: 'n' })) })
  assert.ok(big.label.length <= 120 && big.holder.name.length <= 120 && big.shared.length <= 20)
})

test('sessionProcess: the hook trusts its parent; a CLAUDE_PID mismatch or the CLI walks up to a claude process', () => {
  const lstart = (p) => `t${p}`
  const tree = { 50: { ppid: 40, comm: 'node' }, 40: { ppid: 30, comm: '/usr/local/bin/claude' }, 30: { ppid: 1, comm: 'zsh' } }
  const parentOf = (p) => tree[p] ?? null
  assert.deepEqual(sessionProcess({ env: {}, ppid: 40, lstart, parentOf }), { pid: 40, pidStart: 't40' })
  assert.deepEqual(sessionProcess({ env: { CLAUDE_PID: '40' }, ppid: 40, lstart, parentOf }), { pid: 40, pidStart: 't40' })
  assert.deepEqual(sessionProcess({ env: { CLAUDE_PID: '99' }, ppid: 50, lstart, parentOf }), { pid: 40, pidStart: 't40' }, 'mismatch: walk up')
  assert.deepEqual(sessionProcess({ env: { CLAUDE_PID: '77' }, from: 'cli', lstart, parentOf }), { pid: 77, pidStart: 't77' })
  assert.deepEqual(sessionProcess({ env: {}, from: 'cli', pid: 50, lstart, parentOf }), { pid: 40, pidStart: 't40' })
  assert.deepEqual(sessionProcess({ env: {}, from: 'cli', pid: 30, lstart, parentOf }), { pid: 0, pidStart: '' }, 'none found: unknown')
  assert.equal(findClaudeAncestor(50, parentOf), 40)
})

// --- the hook as Claude Code runs it ---

function hook(mode, payload, home, { desktop = tmp('zarvis-desktop-'), input } = {}) {
  // Not the developer's own session env: CLAUDE_PID would point the hook at the real claude process.
  const { CLAUDE_PID, CLAUDE_CODE_HOST_SESSION_ID, ...env } = process.env
  const r = spawnSync(process.execPath, [HOOK, mode], { input: input ?? JSON.stringify(payload), env: { ...env, ZARVIS_HOME: home, ZARVIS_DESKTOP_SESSIONS: desktop }, encoding: 'utf8', timeout: 8000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('hook end to end: claim, ask, allow-join, whole-tree ask, SessionEnd release (real stdin payloads, real processes)', () => {
  const home = tmp('zarvis-home-')
  const r = repo('proj-3-e2e')
  const first = hook('guard', edit(A, path.join(r, 'src', 'a.js')), home)
  assert.deepEqual([first.code, first.out], [0, ''])
  const c = readClaim(path.join(claimsDir(home), `${claimId(r)}.json`))
  assert.equal(c.label, 'PROJ-3')
  assert.equal(c.holder.pid, process.pid, 'the hook\'s parent is the session process')
  assert.match(c.holder.pidStart, /\d{4}/)

  const pre = edit(B, path.join(r, 'src', 'b.js'), { tool_use_id: 'toolu_e2e' })
  const second = hook('guard', pre, home)
  assert.equal(second.code, 0)
  const out = JSON.parse(second.out)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /claimed by “session aaaaaaaa” \(PROJ-3, branch proj-3-e2e; last write just now\)\. Allow = share this checkout/)

  assert.equal(hook('guardpost', { ...pre, hook_event_name: 'PostToolUse' }, home).out, '')
  assert.equal(hook('guard', edit(B, path.join(r, 'src', 'c.js')), home).out, '')
  assert.match(JSON.parse(hook('guard', bash(A, 'git add -A && git commit -m x', r), home).out).hookSpecificOutput.permissionDecisionReason, /whole-tree git/)
  assert.equal(hook('guard', bash(A, 'git status', r), home).out, '')

  assert.equal(hook('done', { session_id: A, hook_event_name: 'SessionEnd' }, home).code, 0)
  assert.equal(readClaim(path.join(claimsDir(home), `${claimId(r)}.json`)), null, 'the holder ended: released')
})

test('hook: any internal error prints nothing and exits 0', () => {
  const r = repo()
  const home = tmp('zarvis-home-')
  fs.mkdirSync(claimsDir(home), { recursive: true })
  fs.writeFileSync(path.join(claimsDir(home), `${claimId(r)}.json`), '{ corrupt')
  assert.deepEqual(Object.values(hook('guard', edit(A, path.join(r, 'a')), home)).slice(0, 2), [0, ''], 'corrupt claim file')

  const blocked = tmp('zarvis-home-')
  fs.writeFileSync(path.join(blocked, 'claims'), 'a file where the directory should be')
  assert.deepEqual(Object.values(hook('guard', edit(A, path.join(r, 'a')), blocked)).slice(0, 2), [0, ''], 'unreadable claims dir')
  assert.deepEqual(Object.values(hook('guardpost', edit(A, path.join(r, 'a')), blocked)).slice(0, 2), [0, ''])

  for (const input of ['not json', '{}', JSON.stringify({ session_id: '../x', tool_name: 'Edit' }), JSON.stringify({ session_id: A, tool_name: 'Edit', tool_input: null }), JSON.stringify({ session_id: A, tool_name: 'Bash', tool_input: { command: 5 } })]) {
    const res = hook('guard', null, tmp('zarvis-home-'), { input })
    assert.deepEqual([res.code, res.out], [0, ''], input)
  }
})

test('hook: stdin that never closes hits the self-timeout, silently, exit 0', async () => {
  const p = spawn(process.execPath, [HOOK, 'guard'], { env: { ...process.env, ZARVIS_HOME: tmp('zarvis-home-') }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  const t0 = Date.now()
  const [code] = await once(p, 'close')
  assert.equal(code, 0)
  assert.equal(out, '')
  assert.ok(Date.now() - t0 < 3000, 'gave up well before the 5s hook timeout')
})

test('the existing modes are untouched: resume still clears a blocked marker and refreshes working', () => {
  const home = tmp('zarvis-home-')
  fs.mkdirSync(path.join(home, 'blocked'), { recursive: true })
  fs.writeFileSync(path.join(home, 'blocked', `${A}.json`), JSON.stringify({ sessionId: A, at: 1 }))
  assert.equal(hook('resume', { session_id: A, cwd: '/x' }, home).code, 0)
  assert.equal(fs.existsSync(path.join(home, 'blocked', `${A}.json`)), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'working', `${A}.json`), 'utf8')).state, 'working')
})

// --- the CLI ---

function cli(w, cwd) {
  const out = []
  const errs = []
  const run = async (args, extra = {}) => {
    const code = await runClaims(args, {
      home: w.home,
      now: NOW,
      cwd,
      probes: w.deps,
      name: (s) => `name-${s[0]}`,
      self: () => ({ pid: w.pid[extra.as ?? A], pidStart: `start-${w.pid[extra.as ?? A]}` }),
      log: (l) => out.push(l),
      err: (l) => errs.push(l),
      ...extra.opts,
    })
    return { code, out: out.splice(0), err: errs.splice(0) }
  }
  return run
}

test('CLI claim, relabel, refusal by a live holder, release, list', async () => {
  const w = world()
  const r = repo('main')
  const run = cli(w, r)
  const claimed = await run(['claim', 'proj-123', '--by', A])
  assert.deepEqual([claimed.code, claimed.out], [0, [`claimed ${r} as PROJ-123`]])
  assert.deepEqual([claimOf(w, r).label, claimOf(w, r).labelKind, claimOf(w, r).holder.pid], ['PROJ-123', 'manual', 101])

  assert.match((await run(['claim', 'PROJ-124', '--by', A])).out[0], /^relabelled/)
  const refused = await run(['claim', 'PROJ-9', '--by', B], { as: B })
  assert.equal(refused.code, 1)
  assert.equal(refused.err.length, 1)
  assert.match(refused.err[0], /^claims: .* is claimed by “name-a”/)
  assert.equal(claimOf(w, r).label, 'PROJ-124')

  const listed = await run(['list'])
  assert.equal(listed.out.length, 1)
  assert.match(listed.out[0], /^PROJ-124 {2}.* held by name-a \(live\) · last write just now/)
  assert.equal(JSON.parse((await run(['list', '--json'])).out.join('\n'))[0].holder.sessionId, A)

  assert.deepEqual((await run(['release', '--by', B], { as: B })).out, ['nothing to release'])
  assert.deepEqual((await run(['release', '--by', A, '--root', r])).out, [`released PROJ-124 ${r}`])
  assert.equal(claimOf(w, r), null)
  assert.deepEqual((await run(['list'])).out, ['no checkouts claimed'])
})

test('CLI release with no --root gives up every checkout of the session; --root names another directory', async () => {
  const w = world()
  const [r1, r2] = [repo(), repo()]
  const run = cli(w, r1)
  await run(['claim', 'K-1', '--by', A])
  await run(['claim', 'K-2', '--by', A, '--root', r2])
  assert.equal(claimOf(w, r2).label, 'K-2')
  const res = await run(['release', '--by', A])
  assert.equal(res.out.length, 2)
  assert.equal(readClaims(w.home).length, 0)
})

test('CLI takes over a dead holder\'s checkout, and --dry-run writes nothing', async () => {
  const w = world()
  const r = repo()
  const run = cli(w, r)
  assert.equal((await run(['claim', 'K-1', '--by', A, '--dry-run'])).out[0], `would claim ${r} as K-1`)
  assert.equal(claimOf(w, r), null)
  await run(['claim', 'K-1', '--by', A])
  assert.match((await run(['claim', 'K-2', '--by', B, '--dry-run'], { as: B })).err[0], /is claimed by/)
  assert.equal((await run(['release', '--by', A, '--dry-run'])).out[0], `would release K-1 ${r}`)
  assert.equal(claimOf(w, r).holder.sessionId, A)
  w.alive.delete(w.pid[A])
  assert.equal((await run(['claim', 'K-2', '--by', B, '--dry-run'], { as: B })).out[0], `would take over ${r} as K-2`)
  assert.match((await run(['claim', 'K-2', '--by', B], { as: B })).out[0], /^took over/)
  assert.equal(claimOf(w, r).holder.sessionId, B)
})

test('CLI errors are one line and exit 1; the app\'s local_ id resolves through its records', async () => {
  const w = world()
  const r = repo()
  const run = cli(w, r)
  for (const [args, re] of [
    [['claim', 'K-1'], /--by <your session id> is required/],
    [['claim', '--by', A], /claim needs a label/],
    [['claim', 'not a key!', '--by', A], /Jira key/],
    [['claim', 'K-1', '--by', 'x'], /--by must be your own session id/],
    [['claim', 'K-1', '--by', A, '--bogus'], /unknown option/],
    [['claim', 'K-1', '--by', A, '--root'], /needs a value/],
    [['claim', 'K-1', '--by', A, '--root', tmp()], /not inside a git checkout/],
    [['claim', 'K-1', 'K-2', '--by', A], /unexpected argument/],
    [['frobnicate'], /unknown command/],
  ]) {
    const res = await run(args)
    assert.equal(res.code, 1, args.join(' '))
    assert.match(res.err[0], re)
  }
  assert.equal((await run([])).err.length, 2, 'no command: the error plus the usage line')
  const none = await run(['claim', 'K-1', '--by', `local_${A}`], { opts: { deps: { records: [] } } })
  assert.equal(none.code, 1)
  assert.match(none.err[0], /not a session Zarvis knows/)
  const rec = { sessionId: `local_${A}`, cliSessionId: A, title: 'T', cwd: r }
  const ok = await run(['claim', 'K-1', '--by', `local_${A}`], { opts: { deps: { records: [rec] } } })
  assert.equal(ok.code, 0)
  assert.equal(claimOf(w, r).holder.sessionId, A)
})

// --- visibility ---

test('roster has a Checkouts section; an unchanged claim renders identically (minute-granular ages)', () => {
  const w = world()
  const r = repo('feature/proj-8-x')
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  const pre = edit(B, path.join(r, 'b'), { tool_use_id: 'toolu_r' })
  guard(pre, w.ctx(B))
  guardPost(pre, w.ctx(B))
  const views = readClaims(w.home).map((e) => claimView(e, NOW + 5 * MIN, w.deps, { [A]: 'Alice session' }))
  const tree = { interface: [], managers: [], orphans: [], unclassified: [] }
  const text = renderRoster(tree, views, NOW + 5 * MIN)
  assert.match(text, /\n## Checkouts\n/)
  const line = text.split('\n').find((l) => l.startsWith('  - ') && l.includes(r))
  assert.equal(line, `  - ${r} — PROJ-8 › feature/proj-8-x — held by Alice session (session \`${A}\`) — shared with name-b — last write 5m ago — live`)
  assert.equal(renderRoster(tree, views, NOW + 5 * MIN + 30_000), text, 'no seconds, so no rewrite')
  assert.match(renderRoster(tree, [], NOW), /- none claimed/)
  w.alive.delete(w.pid[A])
  assert.match(renderRoster(tree, readClaims(w.home).map((e) => claimView(e, NOW + 5 * MIN, w.deps)), NOW + 5 * MIN), /— dead\n/)
  assert.match(renderRoster(tree, readClaims(w.home).map((e) => claimView(e, NOW + STALE_MS + MIN, w.deps)), NOW + STALE_MS + MIN), /— stale\n/)
})

test('server: /api/claims and the live payload carry claims (read-only, malformed files ignored)', async () => {
  const home = tmp('zarvis-home-')
  const empty = tmp('zarvis-empty-')
  const r = repo('proj-4-srv')
  const w = world()
  w.ctx = (who) => ({ home, now: Date.now(), deps: realDeps, self: () => ({ pid: process.pid, pidStart: realDeps.lstart(process.pid) }), name: () => `name-${who[0]}` })
  guard(edit(A, path.join(r, 'a')), w.ctx(A))
  fs.writeFileSync(path.join(claimsDir(home), '0123456789abcdef.json'), '{nope')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, ZARVIS_HOME: home, ZARVIS_PORT: String(port), ZARVIS_DESKTOP_SESSIONS: empty, ZARVIS_CLI_PROJECTS: empty }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => {
      srv.stdout.on('data', (d) => String(d).includes('Zarvis →') && resolve())
      srv.on('exit', () => reject(new Error('server exited')))
      setTimeout(() => reject(new Error('server did not start')), 8000)
    })
    const body = await (await fetch(`http://127.0.0.1:${port}/api/claims`)).json()
    assert.equal(body.claims.length, 1)
    assert.deepEqual([body.claims[0].root, body.claims[0].label, body.claims[0].holder.sessionId, body.claims[0].live], [r, 'PROJ-4', A, true])
    assert.equal(body.claims[0].holder.pid, undefined, 'no process ids on the wire')
    const q = await (await fetch(`http://127.0.0.1:${port}/api/queue`)).json()
    assert.equal(q.claims[0].label, 'PROJ-4')
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/claims`, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{}' })).status, 404)
    await new Promise((r2) => setTimeout(r2, 300))
    assert.match(fs.readFileSync(path.join(home, 'roster.md'), 'utf8'), /## Checkouts[\s\S]*\n {2}- .*PROJ-4/)
  } finally {
    srv.kill()
  }
})
