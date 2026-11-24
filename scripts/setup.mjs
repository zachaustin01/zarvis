#!/usr/bin/env node
/**
 * Install (or remove) the Zarvis hooks and skills in your Claude Code and Antigravity setups.
 *
 *   npm run setup              add hooks to ~/.claude/settings.json and ~/.gemini/config/hooks.json,
 *                              and skills to ~/.claude/skills/ and ~/.gemini/config/skills/
 *   npm run uninstall-hook     take them out again from both platforms
 *
 * Flags:
 *   --dry-run (print the result, write nothing)
 *   --settings <file> (custom Claude settings file, e.g. .claude/settings.json; skills go beside it)
 *   --skills-dir <dir> (custom Claude skills directory)
 *   --antigravity-hooks <file> (custom Antigravity hooks.json file; skills go beside it)
 *   --antigravity-skills-dir <dir> (custom Antigravity skills directory)
 *   --claude-only (only touch Claude Code setup)
 *   --antigravity-only (only touch Antigravity setup)
 *
 * Only Zarvis's own entries and files are touched; any other hooks and settings are kept as they
 * are. Anything overwritten (the settings/hooks file, or a differing SKILL.md) is backed up next to
 * itself first, and nothing is written if configs are not valid JSON or skill paths are
 * not plain files. Running it again is safe: it leaves exactly one set of hooks and skills.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addHooks, hasHooks, removeHooks } from '../lib/hook-config.mjs'
import { addAntigravityHooks, hasAntigravityHooks, removeAntigravityHooks } from '../lib/antigravity-hook-config.mjs'
import { dqEscape } from '../lib/shell.mjs'

const HOOK_PATH = fileURLToPath(new URL('../hooks/zarvis-hook.mjs', import.meta.url))
const ANTIGRAVITY_HOOK_PATH = fileURLToPath(new URL('../hooks/zarvis-antigravity-hook.mjs', import.meta.url))

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

const SKILLS = ['zarvis-interface', 'zarvis-manager', 'zarvis-worker'].map((name) => ({
  name,
  source: fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
}))

function parseArgs(argv) {
  const args = {
    mode: 'install',
    dryRun: false,
    settings: process.env.CLAUDE_SETTINGS || '',
    skillsDir: process.env.CLAUDE_SKILLS_DIR || '',
    antigravityHooks: process.env.ANTIGRAVITY_HOOKS || '',
    antigravitySkillsDir: process.env.ANTIGRAVITY_SKILLS_DIR || '',
    claudeOnly: false,
    antigravityOnly: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'install' || a === 'uninstall') args.mode = a
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--settings') args.settings = argv[++i] || ''
    else if (a === '--skills-dir') args.skillsDir = argv[++i] || ''
    else if (a === '--antigravity-hooks') args.antigravityHooks = argv[++i] || ''
    else if (a === '--antigravity-skills-dir') args.antigravitySkillsDir = argv[++i] || ''
    else if (a === '--claude-only') args.claudeOnly = true
    else if (a === '--antigravity-only') args.antigravityOnly = true
    else throw new Error(`unknown argument: ${a}`)
  }

  const customClaude = Boolean(args.settings || args.skillsDir)
  const customAgy = Boolean(args.antigravityHooks || args.antigravitySkillsDir)

  if (args.antigravityOnly) {
    args.settings = ''
    args.skillsDir = ''
  } else if (!args.settings && !customAgy) {
    // Default: configure Claude
    args.settings = path.join(os.homedir(), '.claude', 'settings.json')
  }

  if (args.claudeOnly || (customClaude && !customAgy)) {
    // If user specified custom --settings only, don't reach into real ~/.gemini in tests
    args.antigravityHooks = ''
    args.antigravitySkillsDir = ''
  } else if (!args.antigravityHooks) {
    // Default: configure Antigravity
    args.antigravityHooks = path.join(os.homedir(), '.gemini', 'config', 'hooks.json')
  }

  if (args.settings) {
    args.skillsDir ||= path.join(path.dirname(args.settings), 'skills')
  }
  if (args.antigravityHooks) {
    args.antigravitySkillsDir ||= path.join(path.dirname(args.antigravityHooks), 'skills')
  }
  return args
}

async function readConfigFile(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, existed: false }
    throw err
  }
  if (!text.trim()) return { data: {}, existed: true }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object')
    return { data, existed: true }
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix it by hand, nothing was changed`)
  }
}

async function writeConfigFile(file, data, existed) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  let backup = ''
  if (existed) {
    backup = `${file}.zarvis-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await fsp.copyFile(file, backup)
  }
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await fsp.rename(tmp, file)
  return backup
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * What to do about an installed skill file: { name, dest, action: 'write' | 'remove' | 'none', backup }.
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
    await fsp.rmdir(plan.dir).catch(() => {})
  }
  return backup
}

export async function run(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv)
  const install = args.mode === 'install'

  // --- 1. Plan Claude Code changes ---
  let claudeNext = null
  let claudeExisted = false
  const claudeSkills = []
  if (args.settings) {
    const { data, existed } = await readConfigFile(args.settings)
    claudeExisted = existed
    for (const def of SKILLS) claudeSkills.push(await planSkill(args.mode, args.skillsDir, def))
    if (install) {
      if (hasHooks(data, HOOK_PATH)) log(`Zarvis hooks already installed in ${args.settings}`)
      else claudeNext = addHooks(data, HOOK_PATH)
    } else {
      const removed = removeHooks(data)
      if (JSON.stringify(removed) === JSON.stringify(data)) log(`No Zarvis hooks in ${args.settings}`)
      else claudeNext = removed
    }
    for (const skill of claudeSkills) {
      if (skill.action === 'none') {
        log(install ? `${skill.name} skill already installed at ${skill.dest}` : `No ${skill.name} skill at ${skill.dest}`)
      }
    }
  }

  // --- 2. Plan Antigravity changes ---
  let agyNext = null
  let agyExisted = false
  const agySkills = []
  if (args.antigravityHooks) {
    const { data, existed } = await readConfigFile(args.antigravityHooks)
    agyExisted = existed
    for (const def of SKILLS) agySkills.push(await planSkill(args.mode, args.antigravitySkillsDir, def))
    if (install) {
      if (hasAntigravityHooks(data, ANTIGRAVITY_HOOK_PATH)) log(`Zarvis hooks already installed in ${args.antigravityHooks}`)
      else agyNext = addAntigravityHooks(data, ANTIGRAVITY_HOOK_PATH)
    } else {
      const removed = removeAntigravityHooks(data)
      if (JSON.stringify(removed) === JSON.stringify(data)) log(`No Zarvis hooks in ${args.antigravityHooks}`)
      else agyNext = removed
    }
    for (const skill of agySkills) {
      if (skill.action === 'none') {
        log(install ? `${skill.name} skill already installed at ${skill.dest}` : `No ${skill.name} skill at ${skill.dest}`)
      }
    }
  }

  // --- 3. Dry-run reporting ---
  if (args.dryRun) {
    if (claudeNext) log(`Would write ${args.settings}:\n${JSON.stringify(claudeNext, null, 2)}`)
    for (const skill of claudeSkills) {
      if (skill.action === 'write') log(`Would ${skill.backup ? 'back up and overwrite' : 'write'} ${skill.dest}`)
      if (skill.action === 'remove') log(`Would ${skill.backup ? 'back up and ' : ''}remove ${skill.dest}`)
    }
    if (agyNext) log(`Would write ${args.antigravityHooks}:\n${JSON.stringify(agyNext, null, 2)}`)
    for (const skill of agySkills) {
      if (skill.action === 'write') log(`Would ${skill.backup ? 'back up and overwrite' : 'write'} ${skill.dest}`)
      if (skill.action === 'remove') log(`Would ${skill.backup ? 'back up and ' : ''}remove ${skill.dest}`)
    }
    return 0
  }

  // --- 4. Apply changes ---
  const verb = install ? 'Installed' : 'Removed'

  if (claudeNext) {
    const backup = await writeConfigFile(args.settings, claudeNext, claudeExisted)
    log(`${verb} Zarvis hooks in ${args.settings}`)
    if (backup) log(`Backup of previous Claude settings: ${backup}`)
    if (install) log('New Claude Code sessions pick them up; sessions already open need a restart.')
  }
  for (const skill of claudeSkills.filter((k) => k.action !== 'none')) {
    const backup = await applySkill(skill)
    log(`${verb} the ${skill.name} skill at ${skill.dest}`)
    if (backup) log(`Backup of previous skill: ${backup}`)
  }

  if (agyNext) {
    const backup = await writeConfigFile(args.antigravityHooks, agyNext, agyExisted)
    log(`${verb} Zarvis hooks in ${args.antigravityHooks}`)
    if (backup) log(`Backup of previous Antigravity hooks: ${backup}`)
    if (install) log('Antigravity sessions will pick up hooks on their next turn.')
  }
  for (const skill of agySkills.filter((k) => k.action !== 'none')) {
    const backup = await applySkill(skill)
    log(`${verb} the ${skill.name} skill at ${skill.dest}`)
    if (backup) log(`Backup of previous skill: ${backup}`)
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
