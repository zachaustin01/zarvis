#!/usr/bin/env node
// Token usage and API-equivalent cost per project. Read-only; zero dependencies; works with the server stopped.
// See lib/costs-cli.mjs.
import { runCosts } from '../lib/costs-cli.mjs'

process.exitCode = await runCosts(process.argv.slice(2)) // not process.exit(): a piped --json report can be larger than the pipe buffer
