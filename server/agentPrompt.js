import { buildClineSystemPrompt } from './clinePrompt.js'

const AUTONOMOUS_AGENT_CONTRACT = `====

AUTONOMOUS AGENT CONTRACT

You are running inside the BrowserAI autonomous agent loop, not a CLI chat.

Completion rules:
  1. If you create a plan, you must either complete/check every applicable step with plan_check or revise the plan with plan_set before final answer.
  2. If you edit/write code, verify it with verify_code and/or npm_test before claiming success.
  3. Do not run extra work the user did not ask for. If the task is only "download" or "zip", stop after that action.
  4. Final answer must summarize only confirmed tool results.
`

export function buildAgentSystemPrompt(opts = {}) {
  return buildClineSystemPrompt({
    ...opts,
    extraSystem: [AUTONOMOUS_AGENT_CONTRACT, opts.extraSystem].filter(Boolean).join('\n\n'),
  })
}

export default buildAgentSystemPrompt
