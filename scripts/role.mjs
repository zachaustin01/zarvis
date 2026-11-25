#!/usr/bin/env node
// Set / clear / reset / list session roles in Zarvis's own store (~/.zarvis/state.json). Zero dependencies; works with the server stopped.
// See lib/role-cli.mjs.
import { runRole } from '../lib/role-cli.mjs'

process.exitCode = await runRole(process.argv.slice(2))
