#!/usr/bin/env node
// Register a schedule so it shows on Zarvis's Schedule view. Zero dependencies; works with the server stopped.
// See lib/schedule-cli.mjs and the README section "Schedule".
import { runSchedule } from '../lib/schedule-cli.mjs'

process.exit(await runSchedule(process.argv.slice(2)))
