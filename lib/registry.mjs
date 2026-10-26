// The role registry as the server and the park CLI both see it: tags the hook found in a starting
// prompt, overridden by hand-set ones in state.json.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ROLES_DIR } from './markers.mjs'
import { ROLES } from './roles.mjs'

/** Role tags: ones the hook found in a starting prompt, overridden by hand-set ones. */
export async function roleRegistry(state) {
  const tags = {}
  for (const t of await readRoleTags()) tags[t.sessionId] = { role: t.role, parent: t.parent }
  return { ...tags, ...state.roles }
}

export async function readRoleTags() {
  let names = []
  try {
    names = await fsp.readdir(ROLES_DIR)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    try {
      const t = JSON.parse(await fsp.readFile(path.join(ROLES_DIR, n), 'utf8'))
      if (ROLES.includes(t.role) && `${t.sessionId}.json` === n) out.push(t)
    } catch {
      /* mid-write or junk */
    }
  }
  return out
}
