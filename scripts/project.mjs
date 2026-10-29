#!/usr/bin/env node
// Tag sessions with a project (~/.zarvis/projects.json). Zero dependencies; works with the server stopped.
// See lib/project-cli.mjs.
import { runProject } from '../lib/project-cli.mjs'

process.exitCode = await runProject(process.argv.slice(2)) // not process.exit(): a piped --json report can be larger than the pipe buffer
