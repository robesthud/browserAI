import { renderToolsForPrompt } from './agentTools.js'

const XML_TOOL_FORMAT = `# Tool call format

Use XML at top level, never inside markdown:

<xai:function_call>
<xai:tool_name>tool_name</xai:tool_name>
<parameter name="arg">value</parameter>
</xai:function_call>

You may emit multiple independent tool calls in one message. After tool results arrive, continue until the task is done.`

const NATIVE_TOOL_FORMAT = `# Tool calling

Use the provider's native function-calling. Call one or more tools per turn when useful. When all work is actually done, return a concise Russian final answer.`

const AGENT_CONTRACT = `# BrowserAI autonomous agent contract

You are BrowserAI Agent running in an iterative LLM ↔ tools loop with real workspace access.

Non-negotiable rules:
1. Do not do extra work. If the user asked only to download/zip/list/read, stop after that action.
2. For non-trivial work, create a plan with plan_set and close completed steps with plan_check.
3. If a plan exists, do not final-answer while applicable steps remain unchecked. Either complete/check them or revise the plan.
4. Before editing, read the file. Apply changes only via write_file/edit_file.
5. Before risky edits, a rollback snapshot may be created automatically; use workspace_snapshot_restore if recovery requires rollback.
6. After editing code/config, verify with verify_task (preferred) or verify_code/npm_test before claiming success.
7. Before commit/archive/deploy, run or respect secret_scan results; never commit or package secrets.
8. If a tool fails, use the real error to recover. Do not pretend success.
9. Final answer in Russian. Mention only facts confirmed by tool results.
10. Use exact paths from list_files. Linux paths are case-sensitive.
11. Workspace root is /workspace. Do not use /workspace/chats/<id> in tool arguments.
12. Ask the user only when blocked or before risky/destructive actions.`

function userContext({ extraSystem = '', modelHint = '', recall = '', projectRules = '', recentActivity = '', mcpServersBlock = '' } = {}) {
  const parts = []
  if (extraSystem) parts.push(extraSystem.trim())
  if (modelHint) parts.push(modelHint.trim())
  if (recall) parts.push(`# Recalled context\n${recall.trim()}`)
  if (projectRules) parts.push(`# Project rules\n${projectRules.trim()}`)
  if (recentActivity) parts.push(`# Recent workspace activity\n${recentActivity.trim()}`)
  if (mcpServersBlock) parts.push(mcpServersBlock.trim())
  return parts.length ? `# Provided context\n\n${parts.join('\n\n')}` : ''
}

function quickReference() {
  return `# Common workflows

Download repo:
- If routed here instead of deterministic router, call git_clone(url, dest?) only, then final-answer. Do not install/build/test unless user asks.

Archive files:
- Call zip_files(source_path='', output_path='workspace.zip') only, then final-answer with the file path/download info.

Analyze project:
- read_project_rules + list_files
- read relevant README/package/entry files
- search_files for important patterns
- summarize findings with file paths you actually read

Code change:
- read_project_rules + list_files/search_files
- plan_set for multi-step work
- read target files
- edit_file/write_file
- verify_task (preferred) or verify_code/npm_test
- plan_check completed steps
- final concise report`
}

export function buildAgentSystemPrompt({
  extraSystem = '',
  native = false,
  extraTools = null,
  cwd = '/workspace',
  modelHint = '',
  recall = '',
  projectRules = '',
  recentActivity = '',
  mcpServersBlock = '',
  lite = false,
  toolNames = null,
} = {}) {
  if (lite) {
    return [
      'You are BrowserAI — a concise Russian assistant with real tools when needed.',
      'For simple chat, answer directly. For file/command work, use tools.',
      native ? NATIVE_TOOL_FORMAT : XML_TOOL_FORMAT,
      '# Available Tools',
      renderToolsForPrompt(extraTools, { lite: true, toolNames }),
      userContext({ extraSystem, modelHint, recall, projectRules, recentActivity, mcpServersBlock }),
    ].filter(Boolean).join('\n\n')
  }

  return [
    AGENT_CONTRACT,
    native ? NATIVE_TOOL_FORMAT : XML_TOOL_FORMAT,
    quickReference(),
    `# System information\nWorkspace root: ${cwd}\nOS: Linux sandbox\nFinal answer language: Russian`,
    '# Available Tools',
    renderToolsForPrompt(extraTools, { toolNames }),
    userContext({ extraSystem, modelHint, recall, projectRules, recentActivity, mcpServersBlock }),
  ].filter(Boolean).join('\n\n')
}

export default buildAgentSystemPrompt
