#!/usr/bin/env node
// Claim / release / list git checkouts in Zarvis's own store. Zero dependencies; works with the server stopped.
// See lib/claims-cli.mjs for the rules.
import { runClaims } from '../lib/claims-cli.mjs'

process.exit(await runClaims(process.argv.slice(2)))
