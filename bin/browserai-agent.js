#!/usr/bin/env node
import { runAgentCli } from '../server/agentCliRunner.js'

const argv = process.argv.slice(2)
const args = argv[0] === 'agent' ? argv.slice(1) : argv
runAgentCli(args).then((code) => {
  process.exitCode = code
}).catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exitCode = 1
})
