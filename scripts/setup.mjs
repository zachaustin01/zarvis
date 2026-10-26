#!/usr/bin/env node
/**
 * Install (or remove) the Zarvis hooks in your Claude Code settings, and the zarvis-interface and zarvis-manager skills.
 *
 *   npm run setup              add the hooks to ~/.claude/settings.json, the skills to ~/.claude/skills/
 *   npm run uninstall-hook     take them out again
 *
 * Flags: --dry-run (print the result, write nothing), --settings <file> (another settings
 * file, e.g. a project's .claude/settings.json; the skill then goes to a skills/ folder beside it),
 * --skills-dir <dir> (another skills folder). CLAUDE_SETTINGS and CLAUDE_SKILLS_DIR also set them.
 *
 * Only Zarvis's own entries and files are touched; any other hooks and settings are kept as they
 * are. Anything overwritten (the settings file, or a differing SKILL.md) is backed up next to
 * itself first, and nothing is written if the settings are not valid JSON or the skill path is
 * not a plain file. Running it again is safe: it leaves exactly one set of hooks and one skill.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addHooks, hasHooks, removeHooks } from '../lib/hook-config.mjs'
import { dqEscape } from '../lib/shell.mjs'

const HOOK_PATH = fileURLToPath(new URL('../hooks/zarvis-hook.mjs', import.meta.url))
// The shipped skills are templates: {{ZARVIS_DIR}} becomes the absolute path of this clone at install.
const ZARVIS_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const PLACEHOLDER = '{{ZARVIS_DIR}}'
// The placeholder sits inside double quotes in the skill's commands, so the path is escaped for that.
export const render = (template, dir = ZARVIS_DIR) => template.split(PLACEHOLDER).join(dqEscape(dir))

/** Is `text` the template rendered for some clone path? (Then it is ours, even if the clone has moved.) */
function isRendered(text, template) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const [head, ...tail] = template.split(PLACEHOLDER).map(esc)
  if (!tail.length) return text === template
  return new RegExp(`^${head}([^\\n]+?)${tail.join('\\1')}$`).test(text)
}

const SKILLS = ['zarvis-interface', 'zarvis-manager'].map((name) => ({
  name,
  source: fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
}))

function parseArgs(argv) {
  const args = { mode: 'install', dryRun: false, settings: process.env.CLAUDE_SETTINGS || '', skillsDir: process.env.CLAUDE_SKILLS_DIR || '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'install' || a === 'uninstall') args.mode = a
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--settings') args.settings = argv[++i] || ''
    else if (a === '--skills-dir') args.skillsDir = argv[++i] || ''
    else throw new Error(`unknown argument: ${a}`)
  }
  args.settings ||= path.join(os.homedir(), '.claude', 'settings.json')
  // Skills sit beside the settings file, so a custom --settings never reaches into the real ~/.claude.
  args.skillsDir ||= path.join(path.dirname(args.settings), 'skills')
  return args
}

async function readSettings(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, existed: false }
    throw err
  }
  if (!text.trim()) return { settings: {}, existed: true }
  try {
    const settings = JSON.parse(text)
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object')
    return { settings, existed: true }
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix it by hand, nothing was changed`)
  }
}

async function writeSettings(file, settings, existed) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  let backup = ''
  if (existed) {
    backup = `${file}.zarvis-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await fsp.copyFile(file, backup)
  }
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`)
  await fsp.rename(tmp, file)
  return backup
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * What to do about the installed skill file: { name, dest, action: 'write' | 'remove' | 'none', backup }.
 * Reads only. Throws when the destination is not a plain file or directory we could own, so that
 * nothing is written (hooks included) on a state we do not understand.
 */
async function planSkill(mode, skillsDir, { name, source }) {
  const dir = path.join(skillsDir, name)
  const dest = path.join(dir, 'SKILL.md')
  for (const p of [dir, dest]) {
    const st = await fsp.lstat(p).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)))
    if (st && (p === dir ? !st.isDirectory() : !st.isFile())) {
      throw new Error(`${p} is not a plain ${p === dir ? 'directory' : 'file'}; move it aside by hand, nothing was changed`)
    }
  }
  const current = await fsp.readFile(dest, 'utf8').catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)))
  const template = await fsp.readFile(source, 'utf8')
  const shipped = render(template)
  // A copy rendered for another clone path is still ours: replaced or removed without a backup.
  const ours = current !== null && isRendered(current, template)
  if (mode === 'install') {
    if (current === shipped) return { name, dir, dest, action: 'none', backup: false }
    return { name, dir, dest, action: 'write', shipped, backup: current !== null && !ours }
  }
  if (current === null) return { name, dir, dest, action: 'none', backup: false }
  return { name, dir, dest, action: 'remove', backup: !ours }
}

async function applySkill(plan) {
  let backup = ''
  if (plan.backup) {
    backup = `${plan.dest}.zarvis-backup-${stamp()}`
    await fsp.copyFile(plan.dest, backup)
  }
  if (plan.action === 'write') {
    await fsp.mkdir(plan.dir, { recursive: true })
    const tmp = `${plan.dest}.${process.pid}.tmp`
    await fsp.writeFile(tmp, plan.shipped)
    await fsp.rename(tmp, plan.dest)
  } else {
    await fsp.rm(plan.dest)
    await fsp.rmdir(plan.dir).catch(() => {}) // stays if a backup or anything else of yours is in it
  }
  return backup
}

export async function run(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv)
  const install = args.mode === 'install'
  const { settings, existed } = await readSettings(args.settings)
  const skills = []
  for (const def of SKILLS) skills.push(await planSkill(args.mode, args.skillsDir, def)) // all planned before any write

  let next = null
  if (install) {
    if (hasHooks(settings, HOOK_PATH)) log(`Zarvis hooks already installed in ${args.settings}`)
    else next = addHooks(settings, HOOK_PATH)
  } else {
    const removed = removeHooks(settings)
    if (JSON.stringify(removed) === JSON.stringify(settings)) log(`No Zarvis hooks in ${args.settings}`)
    else next = removed
  }
  for (const skill of skills) {
    if (skill.action === 'none') log(install ? `${skill.name} skill already installed at ${skill.dest}` : `No ${skill.name} skill at ${skill.dest}`)
  }

  if (args.dryRun) {
    if (next) log(`Would write ${args.settings}:\n${JSON.stringify(next, null, 2)}`)
    for (const skill of skills) {
      if (skill.action === 'write') log(`Would ${skill.backup ? 'back up and overwrite' : 'write'} ${skill.dest}`)
      if (skill.action === 'remove') log(`Would ${skill.backup ? 'back up and ' : ''}remove ${skill.dest}`)
    }
    return 0
  }

  const verb = install ? 'Installed' : 'Removed'
  if (next) {
    const backup = await writeSettings(args.settings, next, existed)
    log(`${verb} Zarvis hooks in ${args.settings}`)
    if (backup) log(`Backup of the previous file: ${backup}`)
    if (install) log('New Claude Code sessions pick them up; sessions already open need a restart.')
  }
  for (const skill of skills.filter((k) => k.action !== 'none')) {
    const backup = await applySkill(skill)
    log(`${verb} the ${skill.name} skill at ${skill.dest}`)
    if (backup) log(`Backup of the previous file: ${backup}`)
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`zarvis setup: ${err.message}`)
      process.exit(1)
    }
  )
}
