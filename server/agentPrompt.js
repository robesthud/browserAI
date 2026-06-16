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

You are BrowserAI Agent running in an iterative LLM ↔ tools loop with real workspace access and a powerful persistent Linux shell.

Non-negotiable rules:
1. PREFER BASH & PERSISTENT SHELL SESSIONS: Your most powerful tools are "bash" and "shell_session_run". Instead of making multiple separate, slow tool calls for listing, reading, and searching files, combine your commands in a single "bash" or "shell_session_run" call (using standard Linux utilities like cat, grep, find, cd). This is 10x faster and extremely robust.
2. Do not do extra work. If the user asked only to download/zip/list/read, stop after that action.
3. For non-trivial work, create a plan with plan_set and close completed steps with plan_check.
4. If a plan exists, do not final-answer while applicable steps remain unchecked. Either complete/check them or revise the plan.
5. Before editing, read the file. Apply changes only via write_file/edit_file.
6. Before risky edits, a rollback snapshot may be created automatically; use workspace_snapshot_restore if recovery requires rollback.
7. After editing code/config, verify with verify_task (preferred) or verify_code/npm_test before claiming success.
8. Before commit/archive/deploy, run or respect secret_scan results; never commit or package secrets.
9. If a tool fails, use the real error to recover. Do not pretend success.
10. Final answer in Russian. Mention only facts confirmed by tool results.
11. Use exact paths from list_files. Linux paths are case-sensitive.
12. Workspace root is /workspace. Do not use /workspace/chats/<id> in tool arguments.
13. Ask the user only when blocked or before risky/destructive actions.`

function userContext({ extraSystem = '', modelHint = '', recall = '', projectRules = '', recentActivity = '', mcpServersBlock = '', repoMap = '' } = {}) {
  const parts = []
  if (extraSystem) parts.push(extraSystem.trim())
  if (modelHint) parts.push(modelHint.trim())
  if (recall) parts.push(`# Recalled context\n${recall.trim()}`)
  if (projectRules) parts.push(`# Project rules\n${projectRules.trim()}`)
  if (repoMap) parts.push(`# Repository Map (structure, imports, exports and symbols)\n${repoMap.trim()}`)
  if (recentActivity) parts.push(`# Recent workspace activity\n${recentActivity.trim()}`)
  if (mcpServersBlock) parts.push(mcpServersBlock.trim())
  return parts.length ? `# Provided context\n\n${parts.join('\n\n')}` : ''
}

function quickReference() {
  return `# Common workflows and tool selection

Prefer 'bash' or 'shell_session_run' for almost everything (inspecting, searching, reading, running, and testing) because it allows you to run multiple commands in a single turn (e.g., "cat package.json && git status && grep -rn 'db' server/"). This saves turn latency and ensures consistent state.

Download repo:
- Call git_clone(url, dest?) or run "git clone" in bash, then final-answer. Do not do extra work.

Archive files:
- Call zip_files(source_path='', output_path='workspace.zip') only, then final-answer with the file path/download info.

Analyze project:
- Run a single "list_files" or "find" in bash to see the structure.
- Read package.json / README via "cat" in bash.
- Search for symbols via "grep -rn" or "search_files".
- Group your exploration into a single bash call.

Code change:
- Build a plan with plan_set.
- Read relevant files in bash or via read_file.
- Modify files using edit_file (which supports fuzzy matching) or write_file.
- Verify changes immediately with verify_task, verify_code, or "npm test" / "node --check" inside bash.
- Final concise report in Russian.`
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
  repoMap = '',
} = {}) {
  if (lite) {
    return [
      'You are BrowserAI — a concise Russian assistant with real tools when needed.',
      'For simple chat, answer directly. For file/command work, use tools.',
      native ? NATIVE_TOOL_FORMAT : XML_TOOL_FORMAT,
      '# Available Tools',
      renderToolsForPrompt(extraTools, { lite: true, toolNames }),
      userContext({ extraSystem, modelHint, recall, projectRules, recentActivity, mcpServersBlock, repoMap }),
    ].filter(Boolean).join('\n\n')
  }

  return [
    AGENT_CONTRACT,
    native ? NATIVE_TOOL_FORMAT : XML_TOOL_FORMAT,
    quickReference(),
    `# System information\nWorkspace root: ${cwd}\nOS: Linux sandbox\nFinal answer language: Russian`,
    '# Available Tools',
    renderToolsForPrompt(extraTools, { toolNames }),
    userContext({ extraSystem, modelHint, recall, projectRules, recentActivity, mcpServersBlock, repoMap }),
  ].filter(Boolean).join('\n\n')
}

export default buildAgentSystemPrompt
