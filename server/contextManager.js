/**
 * contextManager.js
 *
 * Multi-tier context window management. Replaces the single-threshold
 * maybeAutoCompact() with a graduated strategy that mimics what Claude
 * Code / Cursor / Cline do:
 *
 *   Tier 0 (always on):
 *     Per-tool output budget (smaller for list_files, bigger for
 *     read_file). Trims AT INSERT TIME so the worst-case tool can't
 *     blow the context on its own.
 *
 *   Tier 1 (≥ 45 % of budget):
 *     Aggressively shrink the OLDEST tool observations only —
 *     keep them as a one-line "what I learned" summary, drop the raw
 *     payload. User and assistant turns untouched.
 *
 *   Tier 2 (≥ 65 % of budget):
 *     Collapse the OLDEST third of the whole conversation into a
 *     single digest message (the legacy maybeAutoCompact behaviour,
 *     but with a smarter prompt and now invoked LATER).
 *
 *   Tier 3 (≥ 85 % of budget):
 *     Emergency: hard-drop everything except the system prompt and
 *     the last 4 turns + a 200-char digest of the rest. Logs a warning
 *     so the user knows context was sacrificed.
 *
 * Per-tool budget (Tier 0):
 *   list_files / find_projects / git_status   → 2 KB   (structured, repeats fast)
 *   read_file / web_fetch / file_history      → 12 KB  (one-shot, content-heavy)
 *   bash / verify_code / run_tests            → 8 KB   (output may be huge, head+tail clip)
 *   search_files / kb_search                  → 4 KB
 *   browser_screenshot                        → 1 KB   (path only — image is shown inline)
 *   default                                   → 6 KB
 *
 * Prompt caching (Anthropic):
 *   buildAnthropicCacheControl(messages) tags the static head of the
 *   conversation (system prompt + first user turn if very long) with
 *   `cache_control: { type: 'ephemeral' }`, which lets Anthropic
 *   re-use the cached embeddings on the next call and bills only the
 *   uncached tail. ~90 % savings on second-turn-onwards.
 */
import { tokenBudgetFor } from './modelKnowledge.js'

// Per-tool clip budgets (in characters; ~4 chars/token).
const PER_TOOL_BUDGET = {
  list_files:         { head: 1500,  tail: 500  },
  find_projects:      { head: 1500,  tail: 500  },
  git_status:         { head: 1500,  tail: 500  },
  git_diff:           { head: 4000,  tail: 2000 },
  read_file:          { head: 9000,  tail: 3000 },
  web_fetch:          { head: 9000,  tail: 3000 },
  file_history:       { head: 8000,  tail: 4000 },
  bash:               { head: 5000,  tail: 3000 },
  verify_code:        { head: 5000,  tail: 3000 },
  run_tests:          { head: 5000,  tail: 3000 },
  search_files:       { head: 3000,  tail: 1000 },
  kb_search:          { head: 3000,  tail: 1000 },
  kb_list:            { head: 2000,  tail: 500  },
  recall_facts:       { head: 2000,  tail: 500  },
  web_search:         { head: 4000,  tail: 1000 },
  browser_screenshot: { head:  800,  tail: 200  },
  browser_open:       { head: 1500,  tail: 500  },
  browser_click:      { head:  800,  tail: 200  },
  browser_type:       { head:  800,  tail: 200  },
  analyze_image:      { head: 6000,  tail: 1000 },
  use_subagents:      { head: 8000,  tail: 4000 },
  // default below
}
const DEFAULT_TOOL_BUDGET = { head: 4500, tail: 1500 }

/**
 * Smart hybrid Token Estimator supporting Cyrillic/Russian, CJK, and English/ASCII texts.
 * Highly accurate, prevents context overflows under multi-language user conversations.
 */
export function estimateTokenCount(text) {
  if (!text) return 0
  const str = String(text)
  
  // Count Cyrillic characters: roughly 0.65 tokens per character in UTF-8
  const cyrillicCount = (str.match(/[\u0400-\u04FF]/g) || []).length
  let tokens = cyrillicCount * 0.65
  
  // Count CJK (Chinese, Japanese, Korean) characters: roughly 1.1 tokens per char
  const cjkCount = (str.match(/[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\u2600-\u27BF]/g) || []).length
  tokens += cjkCount * 1.1

  // Count the remaining ASCII character length
  const remainingLength = str.length - cyrillicCount - cjkCount
  
  // English words and spaces: roughly 0.25 tokens per character (chars / 4)
  tokens += remainingLength * 0.25
  
  return Math.ceil(tokens)
}

/**
 * Smart per-tool clip — uses the model-aware budget as a CEILING, then
 * tightens further based on tool semantics. Always returns a string.
 */
export function clipToolOutput(toolName, raw, modelId = '') {
  // Если raw — объект, используем JSON.stringify вместо '[object Object]'
  const str = (raw !== null && typeof raw === 'object')
    ? JSON.stringify(raw, null, 2)
    : String(raw ?? '')
  const modelBudget = tokenBudgetFor(modelId)
  const tool = PER_TOOL_BUDGET[toolName] || DEFAULT_TOOL_BUDGET

  // Use the smaller of (per-tool budget, model budget) — so a 1M-ctx
  // Gemini still gets terse list_files outputs, and a 64k DeepSeek
  // doesn't blow context on one big read_file either.
  const head = Math.min(tool.head, modelBudget.head)
  const tail = Math.min(tool.tail, modelBudget.tail)
  const max = head + tail + 200
  if (str.length <= max) return str
  const hidden = str.length - head - tail
  return `${str.slice(0, head)}\n\n… [${hidden} characters omitted — call with a more specific filter to see the middle] …\n\n${str.slice(-tail)}`
}

/**
 * Estimate how much of the model's context window the convo currently
 * occupies. Returns a number in [0, 1+].
 */
export function contextUsageFraction(convo, modelId) {
  const budget = tokenBudgetFor(modelId)
  let totalTokens = 0
  for (const m of convo) {
    if (typeof m?.content === 'string') {
      totalTokens += estimateTokenCount(m.content)
    } else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        totalTokens += estimateTokenCount(part?.text || '')
      }
    }
  }
  return totalTokens / Math.max(1, budget.ctxTokens)
}

/**
 * Tier 1: shrink OLDEST tool observations to one-line summaries.
 * Preserves user/assistant turns. Returns true if anything changed.
 */
export function shrinkOldToolMessages(convo, { keepRecent = 6 } = {}) {
  // Identify tool messages (role === 'tool' or user-role tool_result envelopes)
  let changed = false
  const toolIdxs = []
  for (let i = 0; i < convo.length; i++) {
    const m = convo[i]
    if (m?.role === 'tool') toolIdxs.push(i)
    else if (m?.role === 'user' && typeof m?.content === 'string' && m.content.startsWith('[tool_result')) {
      toolIdxs.push(i)
    }
  }
  // Keep the most recent N tool observations as-is; collapse the rest.
  const collapseTill = Math.max(0, toolIdxs.length - keepRecent)
  for (let k = 0; k < collapseTill; k++) {
    const i = toolIdxs[k]
    const m = convo[i]
    // stringContent обрабатывает и строки и массивы (multimodal) — Tier 1 работает для обоих
    const original = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map(p => p?.text || '').join('') : ''
    if (original.length < 240) continue   // already short
    const firstLine = (original.split('\n').find((l) => l.trim()) || '').slice(0, 180)
    const head = firstLine
    const sizeNote = `(was ${original.length} chars, summarised)`
    convo[i] = {
      ...m,
      content: m.role === 'tool'
        ? `[summarised earlier tool result ${sizeNote}] ${head}`
        : `[tool_result name="${(m.content.match(/name="([^"]+)"/) || [])[1] || '?'}" summarised ${sizeNote}]\n${head}\n[/tool_result]`,
    }
    changed = true
  }
  return changed
}

/**
 * Tier 2: collapse oldest third of the convo into a single digest.
 * (Refined version of the legacy maybeAutoCompact.)
 */
export function compactMiddle(convo, { keepTail = 8 } = {}) {
  const sys = convo[0]?.role === 'system' ? convo[0] : null
  if (convo.length - (sys ? 1 : 0) <= keepTail + 2) return false
  const middleStart = sys ? 1 : 0
  const middleEnd = convo.length - keepTail
  const middle = convo.slice(middleStart, middleEnd)
  if (!middle.length) return false
  const lines = []
  for (const m of middle) {
    if (m.role === 'user') lines.push(`U: ${stringContent(m).slice(0, 200)}`)
    else if (m.role === 'assistant') {
      const t = stringContent(m).slice(0, 200)
      const tools = Array.isArray(m.tool_calls) ? m.tool_calls.map((tc) => tc?.function?.name || tc?.name).filter(Boolean) : []
      if (tools.length) lines.push(`A→${tools.join(', ')}`)
      if (t) lines.push(`A: ${t}`)
    } else if (m.role === 'tool') {
      lines.push(`T ${m.name || ''}: ${stringContent(m).slice(0, 200)}`)
    }
  }
  const digest = {
    role: 'user',
    content:
      '<arena-system-message>\nTier-2 digest of earlier turns (full text dropped to free context):\n\n' +
      lines.join('\n').slice(0, 4000) +
      '\n</arena-system-message>'

  }
  convo.splice(middleStart, middle.length, digest)
  return true
}

/**
 * Tier 3: emergency drop — keep only system + last 4 turns + tiny digest.
 */
export function emergencyDrop(convo, { keepTail = 4 } = {}) {
  const sys = convo[0]?.role === 'system' ? convo[0] : null
  if (convo.length - (sys ? 1 : 0) <= keepTail + 1) return false
  const middleStart = sys ? 1 : 0
  const middleEnd = convo.length - keepTail
  const dropped = convo.length - middleEnd - middleStart
  const digest = {
    role: 'user',
    content: `<arena-system-message>\nTier-3 emergency drop — ${dropped} earlier messages discarded; only the system prompt and the last ${keepTail} turns remain.\n</arena-system-message>`,
  }
  convo.splice(middleStart, middleEnd - middleStart, digest)
  return true
}

/**
 * Run all tiers in order until usage is back under the safe threshold.
 * Returns { tier, fractionAfter, changed }.
 */
export function manageContext(convo, modelId) {
  // Пересчитываем fraction только когда предыдущий tier что-то изменил
  let usage = contextUsageFraction(convo, modelId)
  let tier = 0
  let changed = false
  if (usage >= 0.45) {
    if (shrinkOldToolMessages(convo)) { tier = 1; changed = true; usage = contextUsageFraction(convo, modelId) }
  }
  if (usage >= 0.65) {
    if (compactMiddle(convo))         { tier = 2; changed = true; usage = contextUsageFraction(convo, modelId) }
  }
  if (usage >= 0.85) {
    if (emergencyDrop(convo))         { tier = 3; changed = true; usage = contextUsageFraction(convo, modelId) }
  }
  return { tier, fractionAfter: usage, changed }
}

function stringContent(m) {
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) {
    return m.content.map((p) => p?.text || '').join('')
  }
  return ''
}

/**
 * Anthropic prompt caching.
 *
 * Caller passes a plain messages[] (system + history). We return a new
 * array where the LAST system message (or the first user message if no
 * system) carries the cache_control: ephemeral marker on its largest
 * content block. Anthropic dedupes the cached prefix and bills only
 * the uncached suffix; ~90 % savings on multi-turn agent runs.
 *
 * Safe noop on non-Anthropic providers: they just ignore the field.
 */
export function applyAnthropicCacheHints(messages, baseUrl = '') {
  const u = String(baseUrl).toLowerCase()
  if (!u.includes('anthropic')) return messages // 'claude' убран — матчил claude.ai (browser session)
  if (!Array.isArray(messages) || !messages.length) return messages

  // Find the SYSTEM message (Anthropic SDK expects an array of content
  // blocks; we wrap the string in [{type:'text', text:..., cache_control}]).
  return messages.map((m) => {
    if (m?.role !== 'system') return m
    const text = typeof m.content === 'string' ? m.content : ''
    if (!text || text.length < 1024) return m  // too short to benefit
    return {
      role: 'system',
      content: [
        { type: 'text', text, cache_control: { type: 'ephemeral' } },
      ],
    }
  })
}

export default {
  clipToolOutput,
  contextUsageFraction,
  shrinkOldToolMessages,
  compactMiddle,
  emergencyDrop,
  manageContext,
  applyAnthropicCacheHints,
  estimateTokenCount,
}

/**
 * Render a compact task-level memory block from the live agent_state.
 * This is different from user memory / semantic memory: it is ephemeral
 * per-run state that helps the model survive context compaction without
 * forgetting the goal, plan, touched files, errors and verification status.
 */
export function renderAgentStateDigest(agentState = {}, recentToolHistory = []) {
  if (!agentState || typeof agentState !== 'object') return ''
  const planSteps = Array.isArray(agentState.plan?.steps) ? agentState.plan.steps : []
  const done = new Set(Array.isArray(agentState.plan?.done) ? agentState.plan.done.map(Number) : [])
  const planLines = planSteps.slice(0, 20).map((s) => {
    const idx = Number(s.idx)
    return `${done.has(idx) || s.done ? '[x]' : '[ ]'} ${idx || '?'} ${String(s.text || '').slice(0, 180)}`
  })
  const tools = (recentToolHistory || []).slice(-15).map((h) => {
    const args = h.args ? `(${String(h.args).slice(0, 120)})` : ''
    const outcome = h.outcome ? ` → ${String(h.outcome).slice(0, 120)}` : ''
    return `${h.ok ? '✓' : '✗'} ${h.tool}${args}${outcome}`
  }).join(', ')
  const lines = [
    '<arena-system-message>\nAuthoritative task-level memory (agent_state_digest):',
    `status: ${agentState.status || 'unknown'}`,
    `goal: ${String(agentState.goal || '').slice(0, 600)}`,
    `phase: ${agentState.phase || 'unknown'} (${agentState.phaseReason || 'n/a'})`,
    `currentStep: ${String(agentState.currentStep || '').slice(0, 240)}`, 
    agentState.completedSteps?.length ? `completedSteps:\n- ${agentState.completedSteps.slice(-12).join('\n- ')}` : '',
    planLines.length ? `plan:\n${planLines.join('\n')}` : '',
    agentState.touchedFiles?.length ? `touchedFiles: ${agentState.touchedFiles.slice(-20).join(', ')}` : '',
    agentState.lastErrors?.length ? `lastErrors:\n- ${agentState.lastErrors.slice(-8).join('\n- ')}` : '',
    agentState.openQuestions?.length ? `openQuestions:\n- ${agentState.openQuestions.slice(-6).join('\n- ')}` : '',
    agentState.nextActions?.length ? `nextActions:\n- ${agentState.nextActions.slice(0, 8).join('\n- ')}` : '',
    tools ? `recentTools: ${tools}` : '',
    `toolStats: total=${agentState.toolStats?.total || 0}, ok=${agentState.toolStats?.ok || 0}, failed=${agentState.toolStats?.failed || 0}`,
    '</arena-system-message>',
  ].filter(Boolean)
  return lines.join('\n').slice(0, 5000)
}

/**
 * Keep exactly one agent_state_digest message in the conversation, directly
 * after the system prompt. Updating one stable message prevents digest spam
 * while guaranteeing tier-2/tier-3 compaction keeps the current task state.
 */
export function upsertAgentStateDigest(convo, agentState, recentToolHistory = []) {
  if (!Array.isArray(convo)) return false
  const digest = renderAgentStateDigest(agentState, recentToolHistory)
  if (!digest) return false
  const marker = '<arena-system-message>\nAuthoritative task-level memory'
  for (let i = convo.length - 1; i >= 0; i -= 1) {
    const c = typeof convo[i]?.content === 'string' ? convo[i].content : ''
    if (c.startsWith(marker)) convo.splice(i, 1)
  }
  const insertAt = convo[0]?.role === 'system' ? 1 : 0
  convo.splice(insertAt, 0, { role: 'user', content: digest })
  return true
}
