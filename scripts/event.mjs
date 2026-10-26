#!/usr/bin/env node
// Push an event into Zarvis's ticker (~/.zarvis/events.jsonl). Zero dependencies; works with the server stopped.
// See lib/events-cli.mjs and the README section "Pushing events".
import { runEvent } from '../lib/events-cli.mjs'

process.exit(await runEvent(process.argv.slice(2)))
