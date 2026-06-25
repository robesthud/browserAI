/**
 * sanitizeAgentText.js — Hide raw tool-call XML from chat UI
 *
 * When the LLM streams its response in agent mode, it sometimes emits raw
 * <xai:function_call>... blocks in assistant_delta events. Without filtering,
 * these show up in the user's chat as ugly XML. This helper:
 *
 * 1. Detects tool-call blocks (function_call, tool_use, tool_call) and replaces
 *    each with a one-line placeholder like "🔧 shell command"
 * 2. Detects thinking/thought blocks and removes them (they're shown separately)
 * 3. Strips stray XML tags that don't belong in user-facing text
 *
 * Designed to be called on each assistant_delta chunk before display, and on
 * the final assistant content before Markdown render.
 */

const THINKING_RE = /<(?:thinking|thought|antml:thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:thinking|thought|antml:thinking|reasoning)>/gi
const STRAY_TAG_RE = /<\/?(?:xai:)?[\w][\w.-]*?(?:\s[^>]*)?>/g

/**
 * Tool name extractor — picks up <tool_name>…</tool_name> or the first attribute.
 * Returns { name, command?, argsPreview? } or null.
 */
function extractToolSummary(block = '') {
  const nameMatch = block.match(/<(?:xai:)?tool_name>([\s\S]*?)<\/(?:xai:)?tool_name>/i)
    || block.match(/<(?:xai:)?tool_use\s+name="([^"]+)"/i)
    || block.match(/name="([^"]+)"/i)
  if (!nameMatch) return null
  const name = String(nameMatch[1] || '').trim()
  const paramMatches = [...block.matchAll(/<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g)]
  let command = ''
  let path = ''
  for (const [, k, v] of paramMatches) {
    if (k === 'command') command = String(v).trim()
    else if (k === 'path' || k === 'file_path') path = String(v).trim()
  }
  const argsPreview = command || path || ''
  return { name, command, path, argsPreview }
}

/**
 * Strip tool-call blocks from streaming text.
 * Each block is replaced with a one-line marker that survives Markdown.
 * Returns { text, stripped } so the UI can render a compact card.
 */
export function sanitizeAssistantDelta(text = '') {
  if (!text) return { text: '', stripped: [] }

  let working = String(text)
  const stripped = []

  // 1. Strip thinking/thought blocks entirely (shown separately via thought events).
  working = working.replace(THINKING_RE, '')

  // 2. Extract tool-call blocks (open + inner content + close) before replacement.
  const blockRe = /<(?:xai:)?(?:function_call|tool_use|tool_call)([^>]*)>[\s\S]*?<\/(?:xai:)?(?:function_call|tool_use|tool_call)>/gi
  working = working.replace(blockRe, (block) => {
    const summary = extractToolSummary(block)
    const idx = stripped.length
    stripped.push(summary || { name: 'tool', argsPreview: '' })
    return `\n\n[tool:${idx}]\n\n`
  })

  // 3. Handle unclosed streaming tool-call blocks (closing tag hasn't arrived yet).
  const openRe = /<(?:xai:)?(?:function_call|tool_use|tool_call)([^>]*)>[\s\S]*$/gi
  working = working.replace(openRe, (block) => {
    const summary = extractToolSummary(block)
    const idx = stripped.length
    stripped.push(summary || { name: 'tool', argsPreview: '' })
    return `\n\n[tool:${idx}]\n\n`
  })

  // 4. Strip stray tags that leaked (anything <xai:...> or <reasoning>, etc.).
  working = working.replace(STRAY_TAG_RE, '')

  return { text: working.trim(), stripped }
}

/**
 * Render-friendly: returns a list of segments.
 * Each segment is either { type: 'text', content } or { type: 'tool', name, argsPreview, idx }.
 * The chat UI can map these to clean components.
 */
export function segmentAssistantText(text = '') {
  const { text: cleaned, stripped } = sanitizeAssistantDelta(text)
  const segments = []
  // Split on [tool:N] markers
  const parts = cleaned.split(/\[tool:(\d+)\]/)
  // parts[0] = leading text, parts[1] = idx, parts[2] = middle text, parts[3] = idx, ...
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const seg = parts[i]?.trim()
      if (seg) segments.push({ type: 'text', content: seg })
    } else {
      const idx = Number(parts[i])
      const tool = stripped[idx] || { name: 'tool', argsPreview: '' }
      segments.push({
        type: 'tool',
        name: tool.name,
        argsPreview: tool.argsPreview,
        idx,
      })
    }
  }
  return segments
}

/**
 * Strip XML from final content (idempotent, safe to run on full assistant string).
 */
export function sanitizeAssistantFinal(text = '') {
  return sanitizeAssistantDelta(text).text
}
