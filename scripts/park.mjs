#!/usr/bin/env node
// Park / unpark / done / undone / done-children / list sessions in Zarvis's own store. Zero dependencies; works with the server stopped.
// See lib/park-cli.mjs for the rules (managers own their workers and themselves; workers may park or mark done themselves).
import { runPark } from '../lib/park-cli.mjs'

process.exit(await runPark(process.argv.slice(2)))
