// The hook entries Zarvis needs in ~/.claude/settings.json, and how to add or remove them
// without disturbing anything else in the file. Pure: takes a settings object, returns a new one.
// The file I/O lives in scripts/setup.mjs.

import { dq } from './shell.mjs'

/** Every entry we own runs this script, which is how one is recognised on the way back out. */
export const HOOK_SCRIPT = 'zarvis-hook.mjs'

/**
 * Event -> list of [matcher or null, hook mode, timeout seconds (optional)]; each becomes its own group,
 * so one event can carry several hooks, which Claude Code runs in parallel. The two claim-guard hooks
 * set an explicit timeout because the default is 10 minutes. Mirrors the table at the top of hooks/zarvis-hook.mjs.
 */
export const HOOK_EVENTS = {
  Notification: [['permission_prompt', 'set']],
  PermissionRequest: [[null, 'set']],
  UserPromptSubmit: [[null, 'start']],
  PreToolUse: [[null, 'resume'], [null, 'guard', 5]],
  PostToolUse: [[null, 'work'], [null, 'guardpost', 5]],
  PermissionDenied: [[null, 'resume']],
  Stop: [[null, 'idle']],
  SessionStart: [[null, 'idle']],
  SessionEnd: [[null, 'done']],
  SubagentStop: [[null, 'agentstop']],
}

/** The shell command for one hook. Quoted, so a clone under a path with spaces still runs. */
export function hookCommand(hookPath, mode) {
  return `node ${dq(hookPath)} ${mode}`
}

const ours = (hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_SCRIPT)

/**
 * `settings` with every Zarvis hook entry taken out. Groups left with no hooks are dropped, then
 * events left with no groups, then `hooks` itself if nothing is left in it. Everything else —
 * other people's hooks included — comes back exactly as it went in.
 */
export function removeHooks(settings) {
  const out = structuredClone(settings ?? {})
  if (!out.hooks || typeof out.hooks !== 'object') return out
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = []
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group)
        continue
      }
      const hooks = group.hooks.filter((h) => !ours(h))
      if (hooks.length === group.hooks.length) kept.push(group)
      else if (hooks.length) kept.push({ ...group, hooks })
    }
    if (kept.length) out.hooks[event] = kept
    else delete out.hooks[event]
  }
  if (!Object.keys(out.hooks).length) delete out.hooks
  return out
}

/**
 * `settings` with the Zarvis hooks pointing at `hookPath`. Old Zarvis entries are removed first,
 * so running setup twice — or again after moving the clone — leaves exactly one set.
 */
export function addHooks(settings, hookPath) {
  const out = removeHooks(settings)
  if (out.hooks !== undefined && (typeof out.hooks !== 'object' || Array.isArray(out.hooks))) {
    throw new Error('settings.json has a "hooks" value that is not an object; fix it by hand first')
  }
  out.hooks ??= {}
  for (const [event, entries] of Object.entries(HOOK_EVENTS)) {
    const groups = entries.map(([matcher, mode, timeout]) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: hookCommand(hookPath, mode), ...(timeout ? { timeout } : {}) }],
    }))
    out.hooks[event] = [...(Array.isArray(out.hooks[event]) ? out.hooks[event] : []), ...groups]
  }
  return out
}

/** Whether `settings` already has exactly the hooks `addHooks` would write. */
export function hasHooks(settings, hookPath) {
  return JSON.stringify(addHooks(settings, hookPath)) === JSON.stringify(settings ?? {})
}
