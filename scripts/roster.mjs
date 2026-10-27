#!/usr/bin/env node
// Look up the sessions Zarvis oversees: names, roles, parent manager, project, branch, running state.
// Read-only; zero dependencies; works with the server stopped. See lib/roster-cli.mjs.
import { runRoster } from '../lib/roster-cli.mjs'

process.exit(await runRoster(process.argv.slice(2)))
