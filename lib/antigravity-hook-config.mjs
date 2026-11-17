// The hook entries Zarvis needs in ~/.gemini/config/hooks.json, and how to add or remove them
// without disturbing anything else in the file. Pure: takes a hooks object, returns a new one.
import { dq } from './shell.mjs'

export const ANTIGRAVITY_HOOK_SCRIPT = 'zarvis-antigravity-hook.mjs'

/** The hook definition for Zarvis in Antigravity's hooks.json schema. */
export function buildAntigravityHookConfig(hookPath) {
  return {
    SessionStart: [
      {
        type: 'command',
        command: `node ${dq(hookPath)} session_start`,
      },
    ],
    PreInvocation: [
      {
        type: 'command',
        command: `node ${dq(hookPath)} pre_invocation`,
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node ${dq(hookPath)} post_tool_use`,
          },
        ],
      },
    ],
    Stop: [
      {
        type: 'command',
        command: `node ${dq(hookPath)} stop`,
      },
    ],
  }
}

/** Check if hooks.json already has exactly the Zarvis hook definition for hookPath. */
export function hasAntigravityHooks(hooksJson, hookPath) {
  if (!hooksJson || typeof hooksJson !== 'object') return false
  const want = buildAntigravityHookConfig(hookPath)
  const have = hooksJson.zarvis
  if (!have || typeof have !== 'object') return false
  return JSON.stringify(have) === JSON.stringify(want)
}

/** Add or update Zarvis hooks in hooks.json without disturbing other hooks. */
export function addAntigravityHooks(hooksJson, hookPath) {
  const out = structuredClone(hooksJson ?? {})
  out.zarvis = buildAntigravityHookConfig(hookPath)
  return out
}

/** Remove Zarvis hooks from hooks.json. Leaves other hooks intact. */
export function removeAntigravityHooks(hooksJson) {
  const out = structuredClone(hooksJson ?? {})
  delete out.zarvis
  return out
}
