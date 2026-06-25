/**
 * agentTools.js — Modularized Registry with Declarative Validation
 *
 * This coordinator imports domain-specific tool categories from the tools/ directory,
 * maps them into a unified TOOLS object, and implements strict declarative validation
 * of arguments and response normalization inside invokeTool() — exactly like Arena.ai / pi-agent-core.
 */

import { PRIVILEGED_TOOLS } from '../runtime/index.js'
import { workspaceTools } from './tools/workspaceTools.js'
import { shellTools } from './tools/shellTools.js'
import { webTools } from './tools/webTools.js'
import { memoryTools } from './tools/memoryTools.js'
import { gitTools } from './tools/gitTools.js'
import { verifyTools } from './tools/verifyTools.js'
import { subagentTools } from './tools/subagentTools.js'
import { reviewTools } from './tools/reviewTools.js'

// Combine all tools into a unified registry
export const TOOLS = {
  ...PRIVILEGED_TOOLS,
  ...workspaceTools,
  ...shellTools,
  ...webTools,
  ...memoryTools,
  ...gitTools,
  ...verifyTools,
  ...subagentTools,
  ...reviewTools,
}

export const LITE_TOOL_NAMES = [
  'bash', 'ask_user', 'read_project_rules',
  'list_files', 'read_file', 'write_file', 'edit_file', 'search_files', 'delete_file', 'verify_code',
  'web_search', 'web_fetch',
  'generate_image', 'edit_image', 'analyze_image', 'transcribe_audio',
]

function err(message) { return { ok: false, error: String(message || 'unknown error') } }
function ok(result) { return { ok: true, result } }

export function renderToolsForPrompt(extraTools = null, { lite = false, toolNames = null } = {}) {
  let combined = extraTools && typeof extraTools === 'object' ? { ...TOOLS, ...extraTools } : TOOLS
  if (Array.isArray(toolNames) && toolNames.length > 0) {
    const allowed = new Set(toolNames)
    combined = Object.fromEntries(Object.entries(combined).filter(([name]) => allowed.has(name)))
  } else if (lite) {
    const allowed = new Set(LITE_TOOL_NAMES)
    combined = Object.fromEntries(Object.entries(combined).filter(([name]) => allowed.has(name)))
  }

  const lines = []
  for (const [name, def] of Object.entries(combined)) {
    lines.push(`### ${name}`)
    lines.push(def.description)
    const params = Object.entries(def.params || {})
    if (params.length) {
      lines.push('Parameters:')
      for (const [p, meta] of params) {
        const flag = meta.required ? '(required)' : '(optional)'
        lines.push(`  - "${p}" ${flag} — ${meta.type}: ${meta.description || ''}`)
      }
    } else {
      lines.push('No parameters.')
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Invokes a tool with declarative parameter validation and response normalization.
 * Matches badlogic/pi-mono (Arena.ai) standard tool execution behaviors.
 */
export async function invokeTool(name, args = {}, { signal, onStdout, onStderr, userId, chatId, extraTools, parentJobId = '' } = {}) {
  const tool = TOOLS[name] || (extraTools && extraTools[name])
  if (!tool) return err(`Unknown tool: ${name}`)
  if (typeof tool.handler !== 'function') return err(`Tool ${name} has no handler`)

  const enrichedArgs = { ...(args || {}) }
  
  // ── Declarative Parameter Validation & Normalization ──
  const paramsMeta = tool.params || {}
  const validatedArgs = {}

  for (const [pName, meta] of Object.entries(paramsMeta)) {
    let val = enrichedArgs[pName]

    // 1. Fill default values
    if (val === undefined && 'default' in meta) {
      val = meta.default
    }

    // 2. Validate required
    if (meta.required && (val === undefined || val === null || val === '')) {
      return err(`Validation Error: Required parameter "${pName}" for tool "${name}" is missing or empty.`)
    }

    if (val !== undefined && val !== null) {
      // 3. Validate types and safely cast where possible
      if (meta.type === 'string' && typeof val !== 'string') {
        val = String(val)
      } else if (meta.type === 'number') {
        const num = Number(val)
        if (isNaN(num)) {
          return err(`Validation Error: Parameter "${pName}" for tool "${name}" must be a number, received "${val}".`)
        }
        val = num
      } else if (meta.type === 'boolean') {
        if (typeof val !== 'boolean') {
          val = val === 'true' || val === true || val === 1
        }
      }
      validatedArgs[pName] = val
    }
  }

  // Preserve internal execution metadata/callbacks (passed as underscore variables)
  if (userId) validatedArgs._userId = userId
  if (chatId) validatedArgs._chatId = chatId
  if (signal) validatedArgs._signal = signal
  if (onStdout) validatedArgs._onStdout = onStdout
  if (onStderr) validatedArgs._onStderr = onStderr
  if (parentJobId) validatedArgs._parentJobId = parentJobId  // S4-D1: propagate for spawn_agent hierarchy

  try {
    if (signal?.aborted) return err('cancelled')
    const rawResult = await tool.handler(validatedArgs)
    
    // ── Declarative Response Normalization ──
    // Ensure all tool handlers return a uniform { ok: boolean, result?: any, error?: string } shape.
    if (rawResult && typeof rawResult === 'object' && ('ok' in rawResult)) {
      return rawResult
    }
    
    // Auto-wrap non-standard return formats for backwards compatibility
    return ok(rawResult)
  } catch (e) {
    if (signal?.aborted) return err('cancelled')
    return err(e?.message || String(e))
  }
}
