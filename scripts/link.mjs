#!/usr/bin/env node
// Post links to a session's card in Zarvis. Zero dependencies; works with the server stopped.
// See lib/links-cli.mjs and the README section "Session links".
import { runLink } from '../lib/links-cli.mjs'

process.exit(await runLink(process.argv.slice(2)))
