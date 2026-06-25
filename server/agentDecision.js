/**
 * agentDecision.js
 *
 * Provider-agnostic decision extraction layer for BrowserAI Agent Mode.
 * The agent loop should not guess whether model text is a final answer,
 * native tool call, XML tool call, or a disguised shell command. This module
 * normalizes all model output into one explicit decision object.
 */

const SHELL_COMMAND_WORDS = 'pwd|ls|find|grep|rg|cat|sed|awk|python3?|node|npm|pnpm|yarn|git|curl|docker|mkdir|cp|mv|rm|cd'
const SHELL_START_RE = new RegExp(`(^|\\n)\\s*(${SHELL_COMMAND_WORDS})\\b`, 'i')
const INLINE_SHELL_RE = new RegExp('`([^`]*(?:' + SHELL_COMMAND_WORDS + ')\\b[^`]*)`', 'gi')
const FENCED_SHELL_RE = /```(?:bash|sh|shell)\s*\n([\s\S]*?)```/gi
const XML_TOOL_CALL_RE = /<(?:x?ai:function_call|tool_use|function_call)([^>]*)>([\s\S]*?)<\/(?:x?ai:function_call|tool_use|function_call)>/gi

export const DIRECT_TOOL_NAMES = [
  'plan_set', 'plan_check', 'ask_user',
  'read_file', 'write_file', 'edit_file', 'delete_file', 'list_files', 'search_files',
  'file_read', 'file_write', 'file_edit', 'file_delete', 'file_list', 'file_search',
  'bash', 'shell', 'shell_session_run', 'shell_background_start', 'shell_background_read', 'shell_background_stop',
  'verify_code', 'verify_task', 'npm_test', 'git_status', 'git_clone', 'git_commit', 'web_search', 'web_fetch',
]
const DIRECT_TOOL_NAME_RE = DIRECT_TOOL_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const DIRECT_TOOL_OPEN_RE = new RegExp(`<(${DIRECT_TOOL_NAME_RE})([^>]*)>`, 'ig')


export function makeXmlParamRe() {
  return /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi
}

function safeJson(text, fallback = null) {
  try { return JSON.parse(String(text || '')) } catch { return fallback }
}

function parseAttrs(attrs = '') {
  const out = {}
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(String(attrs || ''))) !== null) out[m[1]] = m[2] ?? m[3] ?? ''
  return out
}

export function isDirectToolTag(tagName = '') {
  const clean = String(tagName || '').toLowerCase().replace(/^\//, '').replace(/^x?ai:/, '').trim()
  return DIRECT_TOOL_NAMES.includes(clean)
}

function argsFromDirectBody(tool = '', body = '', attrs = '') {
  const args = parseAttrs(attrs)
  const content = String(body || '').trim()
  if (!content) return args
  const parsed = safeJson(content, undefined)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(args, parsed)
  else if (Array.isArray(parsed)) args.steps = parsed
  else if (/write/i.test(tool) && args.content == null) args.content = content
  else if (/edit/i.test(tool) && args.new_text == null && args.old_text != null) args.new_text = content
  else if (tool === 'plan_set' && args.plan == null && args.steps == null) args.plan = content
  else if (args.content == null && !Object.keys(args).length) args.content = content
  return args
}

function cleanShellCandidate(candidate = '') {
  return String(candidate || '')
    .replace(/```[a-z0-9_+-]*/gi, '')
    .replace(/```/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      // Drop prose-only Russian lines that sometimes surround pasted commands.
      if (/^[А-Яа-яЁё][А-Яа-яЁё\s,.:;!?-]+$/.test(t)) return false
      return true
    })
    .join('\n')
    .trim()
}

function firstValidShellCommand(candidates = []) {
  for (const candidate of candidates) {
    const cleaned = cleanShellCandidate(candidate)
    if (!cleaned) continue
    if (SHELL_START_RE.test(cleaned)) return cleaned.slice(0, 8000)
  }
  return ''
}

export function extractMarkdownShell(text = '') {
  const raw = String(text || '')
  const blocks = [...raw.matchAll(FENCED_SHELL_RE)].map((m) => m[1])
  return firstValidShellCommand(blocks)
}

export function extractInlineShell(text = '') {
  const raw = String(text || '')
  const inlineCommands = [...raw.matchAll(INLINE_SHELL_RE)].map((m) => m[1])
  if (!inlineCommands.length) {
    const inline = raw.match(new RegExp(`(?:^|\\n)\\s*((?:${SHELL_COMMAND_WORDS})\\b[\\s\\S]{0,1200})`, 'i'))
    if (inline) inlineCommands.push(inline[1])
  }
  return firstValidShellCommand(inlineCommands)
}

export function extractMarkdownShellCommand(text = '') {
  return extractMarkdownShell(text) || extractInlineShell(text)
}

export function parseXmlToolBody(body = '', tagName = '', openAttrs = '') {
  const tag = String(tagName || '').toLowerCase().replace(/^x?ai:/, '')
  if (tag === 'thinking' || tag === 'thought' || tag === 'think') return { kind: 'thinking', text: String(body || '').trim() }

  if (isDirectToolTag(tag)) {
    return { kind: 'tool', tool: tag, args: argsFromDirectBody(tag, body, openAttrs) }
  }

  const content = String(body || '')
  const nameMatch =
    content.match(/<(?:x?ai:)?tool_name>([^<]+)<\/(?:x?ai:)?tool_name>/i) ||
    content.match(/<tool_name>([^<]+)<\/tool_name>/i) ||
    content.match(/<name>([^<]+)<\/name>/i) ||
    String(openAttrs || '').match(/name\s*=\s*["']([^"']+)["']/i)

  let tool = nameMatch ? nameMatch[1].trim() : ''
  if (!tool) {
    const line1 = content.trim().split('\n')[0]
    if (line1 && /^[a-z_][a-z0-9_-]*$/i.test(line1)) tool = line1
  }
  if (!tool) return null

  const args = {}
  const paramRe = makeXmlParamRe()
  let pm
  while ((pm = paramRe.exec(content)) != null) args[pm[1]] = pm[2].trim()

  const invokeJsonMatch = content.match(/<invoke[^>]*>([\s\S]*?)<\/invoke>/i)
  if (invokeJsonMatch) Object.assign(args, safeJson(invokeJsonMatch[1].trim(), {}) || {})

  return { kind: 'tool', tool, args }
}

export function parseXmlFunctionCalls(text = '') {
  let cleaned = String(text || '')
  // Strip DeepSeek/R1 thinking blocks to prevent false parses from reasoning text.
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '')

  const calls = []
  XML_TOOL_CALL_RE.lastIndex = 0
  let match
  while ((match = XML_TOOL_CALL_RE.exec(cleaned)) !== null) {
    const parsed = parseXmlToolBody(match[2] || '', 'function_call', match[1] || '')
    if (parsed?.kind === 'tool') calls.push({ tool: parsed.tool, args: parsed.args || {} })
  }

  // Direct model-emitted tags: <plan_set>{...}, <file_write path="x">...</file_write>,
  // including DeepSeek-style tags that are never closed. We stop a block at the
  // next direct tool tag so a stream like <plan_set>{...}<file_write ...>body
  // yields two calls.
  DIRECT_TOOL_OPEN_RE.lastIndex = 0
  let dm
  while ((dm = DIRECT_TOOL_OPEN_RE.exec(cleaned)) !== null) {
    const fullOpenEnd = DIRECT_TOOL_OPEN_RE.lastIndex
    const tag = dm[1]
    const attrs = dm[2] || ''
    const closeRe = new RegExp(`</${tag}>`, 'ig')
    closeRe.lastIndex = fullOpenEnd
    const close = closeRe.exec(cleaned)
    let bodyEnd = close ? close.index : cleaned.length
    DIRECT_TOOL_OPEN_RE.lastIndex = fullOpenEnd
    const next = DIRECT_TOOL_OPEN_RE.exec(cleaned)
    if (next && next.index > fullOpenEnd && next.index < bodyEnd) bodyEnd = next.index
    const body = cleaned.slice(fullOpenEnd, bodyEnd)
    const parsed = parseXmlToolBody(body, tag, attrs)
    if (parsed?.kind === 'tool') calls.push({ tool: parsed.tool, args: parsed.args || {} })
    DIRECT_TOOL_OPEN_RE.lastIndex = close ? close.index + close[0].length : bodyEnd
  }
  return calls
}

export function extractNativeToolCalls(reply = {}, { correctToolName = (n) => n, toolExists = () => true } = {}) {
  const calls = []
  if (!Array.isArray(reply?.toolCalls)) return calls
  for (const tc of reply.toolCalls) {
    const corrected = correctToolName(tc.name)
    const exists = Boolean(toolExists(corrected))
    calls.push({
      tool: corrected,
      args: tc.args || {},
      nativeId: tc.id,
      nativeRaw: tc.raw,
      unknown: !exists,
    })
  }
  return calls
}

export function normalizeParsedCalls(rawCalls = [], { correctToolName = (n) => n, toolExists = () => true } = {}) {
  return (rawCalls || []).map((c) => {
    const corrected = correctToolName(c.tool)
    const exists = Boolean(toolExists(corrected))
    return {
      tool: corrected,
      args: c.args || {},
      unknown: !exists,
      ...(c.nativeId ? { nativeId: c.nativeId } : {}),
      ...(c.nativeRaw ? { nativeRaw: c.nativeRaw } : {}),
    }
  })
}

export function extractAgentDecision({ reply = {}, useNativeTools = false, correctToolName = (n) => n, toolExists = () => true } = {}) {
  if (Array.isArray(reply?.preParsedCalls) && reply.preParsedCalls.length > 0) {
    const parsed = reply.preParsedCalls.filter((c) => c?.kind !== 'thinking' && c?.tool)
    if (parsed.length > 0) {
      return { type: 'tool_calls', calls: normalizeParsedCalls(parsed, { correctToolName, toolExists }), source: 'stream_parser' }
    }
  }

  if (useNativeTools && Array.isArray(reply?.toolCalls) && reply.toolCalls.length > 0) {
    const calls = extractNativeToolCalls(reply, { correctToolName, toolExists })
    if (calls.length > 0) return { type: 'tool_calls', calls, source: 'native' }
  }

  const text = String(reply?.text || '')
  const xmlCalls = parseXmlFunctionCalls(text)
  if (xmlCalls.length > 0) {
    return { type: 'tool_calls', calls: normalizeParsedCalls(xmlCalls, { correctToolName, toolExists }), source: 'xml' }
  }

  const markdownShellCommand = extractMarkdownShellCommand(text)
  if (markdownShellCommand) {
    return {
      type: 'tool_calls',
      calls: [{ tool: 'shell', args: { action: 'run', command: markdownShellCommand }, unknown: !toolExists('shell') }],
      source: 'markdown_shell',
    }
  }

  if (!text.trim()) return { type: 'invalid', reason: 'empty_model_response', text: '' }
  return { type: 'final', text, source: 'assistant_text' }
}

export const __test = {
  cleanShellCandidate,
  firstValidShellCommand,
  SHELL_START_RE,
}
