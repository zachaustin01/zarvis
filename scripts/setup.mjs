#!/usr/bin/env node
/**
 * Install (or remove) the Zarvis hooks in your Claude Code settings.
 *
 *   npm run setup              add the hooks to ~/.claude/settings.json
 *   npm run uninstall-hook     take them out again
 *
 * Flags: --dry-run (print the result, write nothing), --settings <file> (another settings
 * file, e.g. a project's .claude/settings.json). CLAUDE_SETTINGS also sets the file.
 *
 * Only Zarvis's own entries are touched; any other hooks and settings are kept as they are. The
 * file is backed up next to itself before the first write, and never written if it is not
 * valid JSON. Running it again is safe: it leaves exactly one set of Zarvis hooks.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addHooks, hasHooks, removeHooks } from '../lib/hook-config.mjs'

const HOOK_PATH = fileURLToPath(new URL('../hooks/zarvis-hook.mjs', import.meta.url))

function parseArgs(argv) {
  const args = { mode: 'install', dryRun: false, settings: process.env.CLAUDE_SETTINGS || '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'install' || a === 'uninstall') args.mode = a
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--settings') args.settings = argv[++i] || ''
    else throw new Error(`unknown argument: ${a}`)
  }
  args.settings ||= path.join(os.homedir(), '.claude', 'settings.json')
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

export async function run(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv)
  const { settings, existed } = await readSettings(args.settings)

  let next
  if (args.mode === 'install') {
    if (hasHooks(settings, HOOK_PATH)) {
      log(`Zarvis hooks already installed in ${args.settings}`)
      return 0
    }
    next = addHooks(settings, HOOK_PATH)
  } else {
    next = removeHooks(settings)
    if (JSON.stringify(next) === JSON.stringify(settings)) {
      log(`No Zarvis hooks in ${args.settings}`)
      return 0
    }
  }

  if (args.dryRun) {
    log(`Would write ${args.settings}:\n${JSON.stringify(next, null, 2)}`)
    return 0
  }
  const backup = await writeSettings(args.settings, next, existed)
  log(`${args.mode === 'install' ? 'Installed' : 'Removed'} Zarvis hooks in ${args.settings}`)
  if (backup) log(`Backup of the previous file: ${backup}`)
  if (args.mode === 'install') log('New Claude Code sessions pick them up; sessions already open need a restart.')
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
