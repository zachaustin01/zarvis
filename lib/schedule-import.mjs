// Read-only importers: jobs that something other than `npm run schedule` already knows about, shown with
// their source tag (`'claude'` or `'antigravity'`) and never written back.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanCron } from './cron.mjs'
import { parseJob } from './schedule.mjs'

const CRON_TZ_RE = /^CRON_TZ=(\S+)\s+(.+)$/

function defaultConfigDir() {
  return process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), '.gemini', 'config')
}

async function readDisabledSidecars(userConfigFile) {
  const disabled = new Set()
  try {
    const cfg = JSON.parse(await fsp.readFile(userConfigFile, 'utf8'))
    if (Array.isArray(cfg?.disabledSidecars)) {
      for (const s of cfg.disabledSidecars) if (typeof s === 'string') disabled.add(s)
    }
    if (cfg?.sidecars && typeof cfg.sidecars === 'object') {
      for (const [slug, v] of Object.entries(cfg.sidecars)) {
        if (v === false || v?.enabled === false) disabled.add(slug)
      }
    }
  } catch { /* missing or malformed user_config.json */ }
  return disabled
}

/**
 * Read-only importer for Antigravity standalone Automations under `~/.gemini/config/sidecars/<slug>/sidecar.json`.
 * Never writes to `schedules.json`.
 */
export async function importAntigravitySidecars({
  sidecarsDir = path.join(defaultConfigDir(), 'sidecars'),
  userConfigFile = path.join(path.dirname(sidecarsDir), 'user_config.json'),
} = {}) {
  let entries
  try {
    entries = await fsp.readdir(sidecarsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const disabled = await readDisabledSidecars(userConfigFile)
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || disabled.has(e.name)) continue
    try {
      const sc = JSON.parse(await fsp.readFile(path.join(sidecarsDir, e.name, 'sidecar.json'), 'utf8'))
      if (sc?.builtin !== 'schedule' || sc?.enabled === false) continue
      const rawArg = String(sc.args?.[0] ?? '').trim()
      const tzMatch = CRON_TZ_RE.exec(rawArg)
      const tz = tzMatch ? tzMatch[1] : ''
      const cron = cleanCron(tzMatch ? tzMatch[2] : rawArg)
      if (!cron) continue
      const name = String(sc.display_name || e.name).trim()
      const desc = String(sc.description || '').trim()
      const tzNote = tz && tz !== localTz ? `[TZ: ${tz}]` : ''
      const note = [desc, tzNote].filter(Boolean).join(' ')
      out.push({ name, cron, note, source: 'antigravity' })
    } catch { /* skip malformed sidecar */ }
  }
  return out
}

const IMPORTERS = [importAntigravitySidecars]

/** Imported jobs from every importer, validated, keeping each importer's source tag (default `'claude'`). */
export async function importSchedules(importers = IMPORTERS) {
  const out = []
  for (const run of importers) {
    try {
      for (const raw of await run()) {
        const source = raw?.source === 'antigravity' ? 'antigravity' : 'claude'
        const j = parseJob({ ...raw, source })
        if (j) out.push(j)
      }
    } catch { /* best effort */ }
  }
  return out
}
