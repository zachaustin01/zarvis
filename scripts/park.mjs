#!/usr/bin/env node
// Park / unpark / list sessions in Zarvis's own store. Zero dependencies; works with the server stopped.
// See lib/park-cli.mjs for the rules (a manager may park only its own idle workers).
import { runPark } from '../lib/park-cli.mjs'

process.exit(await runPark(process.argv.slice(2)))
