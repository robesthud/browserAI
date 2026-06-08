/**
 * Coarse capability lookup for the LLM the agent is currently running on:
 *   - approximate context window in tokens
 *   - whether the model supports images / video input
 *   - whether it's "cheap" (fine for grep / read_file) or "expensive"
 *     (better for edit_file / planning)
 *
 * Used by:
 *  - agentLoop to clip tool outputs more aggressively when the context
 *    is small (DeepSeek 64k → cap at 4 KB; Claude 200k → cap at 16 KB);
 *  - the system prompt so the model can pace itself ("you only have
 *    ~60k tokens of memory, summarise long files").
 *
 * Match is by substring on the model id (case-insensitive). A best-effort
 * fallback returns conservative defaults.
 */
// price = USD per 1M tokens, [input, output]. Rough, public as of 2025-Q2.
// Used by costTracker; missing entry → cost shown as $0 (best-effort).
const RULES = [
  // OpenAI
  { match: /gpt-4o-mini/i,                       ctx: 128_000,   tier: 'cheap',     vision: true,  price: [0.15, 0.60] },
  { match: /gpt-4o(?!-mini)/i,                   ctx: 128_000,   tier: 'expensive', vision: true,  price: [2.50, 10.00] },
  { match: /gpt-4(\.5|-turbo)?/i,                ctx: 128_000,   tier: 'expensive', vision: true,  price: [10.0, 30.00] },
  { match: /o4-mini|o1-mini/i,                   ctx: 128_000,   tier: 'cheap',     vision: true,  price: [1.10, 4.40] },
  { match: /o1\b|o3\b/i,                         ctx: 200_000,   tier: 'expensive', vision: true,  price: [15.0, 60.00] },
  // Anthropic
  { match: /claude.*opus/i,                      ctx: 200_000,   tier: 'expensive', vision: true,  price: [15.0, 75.00] },
  { match: /claude.*(sonnet-4|4-sonnet|3-7)/i,   ctx: 200_000,   tier: 'expensive', vision: true,  price: [3.00, 15.00] },
  { match: /claude.*(haiku|3-5-haiku)/i,         ctx: 200_000,   tier: 'cheap',     vision: true,  price: [0.80, 4.00] },
  { match: /claude/i,                            ctx: 200_000,   tier: 'expensive', vision: true,  price: [3.00, 15.00] },
  // Google Gemini
  { match: /gemini-2\.5-pro|gemini-1\.5-pro/i,   ctx: 1_000_000, tier: 'expensive', vision: true,  price: [1.25, 5.00] },
  { match: /gemini.*flash/i,                     ctx: 1_000_000, tier: 'cheap',     vision: true,  price: [0.075, 0.30] },
  // DeepSeek
  { match: /deepseek.*reasoner|r1/i,             ctx: 64_000,    tier: 'expensive', vision: false, price: [0.55, 2.19] },
  { match: /deepseek/i,                          ctx: 64_000,    tier: 'cheap',     vision: false, price: [0.14, 0.28] },
  // Qwen / Mistral / Llama
  { match: /qwen.*(72b|max|plus)/i,              ctx: 128_000,   tier: 'expensive', vision: false, price: [0.40, 1.20] },
  { match: /qwen/i,                              ctx: 32_000,    tier: 'cheap',     vision: false, price: [0.05, 0.20] },
  { match: /mistral-large|codestral/i,           ctx: 32_000,    tier: 'expensive', vision: false, price: [2.00, 6.00] },
  { match: /llama-3\.[12]?-(70|405)b/i,          ctx: 128_000,   tier: 'expensive', vision: false, price: [0.90, 0.90] },
  { match: /llama/i,                             ctx: 32_000,    tier: 'cheap',     vision: false, price: [0.05, 0.10] },
]

export function lookupModel(modelId = '') {
  const id = String(modelId || '')
  for (const r of RULES) if (r.match.test(id)) {
    return { id, ctx: r.ctx, tier: r.tier, vision: r.vision, price: r.price || [0, 0] }
  }
  return { id, ctx: 32_000, tier: 'cheap', vision: false, price: [0, 0] }
}

/**
 * Cost in USD for a single LLM call.
 * promptTokens / completionTokens come from provider's usage block.
 */
export function priceFor(modelId, promptTokens = 0, completionTokens = 0) {
  const m = lookupModel(modelId)
  const [inP, outP] = m.price || [0, 0]
  const cost = (promptTokens * inP + completionTokens * outP) / 1_000_000
  return { cost, inputUsd: (promptTokens * inP) / 1e6, outputUsd: (completionTokens * outP) / 1e6 }
}

/**
 * Suggest a cheaper sibling model from the same provider family.
 * Used by Architect/Editor router when planner picks an expensive model
 * but the next step is mechanical (read_file / edit_file).
 * Returns null when no cheaper sibling is known.
 */
export function suggestCheapSibling(modelId = '') {
  const id = String(modelId || '').toLowerCase()
  if (/gpt-4o(?!-mini)|gpt-4(\.5|-turbo)?/.test(id)) return 'gpt-4o-mini'
  if (/claude.*(opus|sonnet)/.test(id))              return id.replace(/(opus|sonnet[-_]?\d?)/, 'haiku')
  if (/gemini.*pro/.test(id))                        return id.replace(/pro/, 'flash')
  if (/deepseek.*(reasoner|r1)/.test(id))            return 'deepseek-chat'
  if (/qwen.*(72b|max|plus)/.test(id))               return id.replace(/(72b|max|plus)/, 'turbo')
  if (/o1\b|o3\b/.test(id))                          return 'gpt-4o-mini'
  return null
}

/**
 * The inverse of suggestCheapSibling: if the agent is running on a
 * cheap/fast model, suggest a stronger sibling in the same family for
 * critical-thinking tasks (reflection, architectural decisions).
 * Returns null when no stronger sibling is known.
 */
export function suggestStrongSibling(modelId = '') {
  const id = String(modelId || '').toLowerCase()
  if (/gpt-4o-mini|o4-mini|o1-mini/.test(id))   return 'gpt-4o'
  if (/claude.*haiku/.test(id))                 return id.replace(/haiku/, 'sonnet-4')
  if (/gemini.*flash/.test(id))                 return id.replace(/flash/, 'pro')
  if (/deepseek-(chat|coder)/.test(id))         return 'deepseek-reasoner'
  if (/qwen.*(turbo|small|7b)/.test(id))        return id.replace(/(turbo|small|7b)/, 'plus')
  if (/llama.*(8b|small)/.test(id))             return id.replace(/(8b|small)/, '70b')
  return null
}

/**
 * Suggested per-tool-output clip size for the current model. The agent loop
 * uses this in clipForLLM() instead of a fixed cap so a 64 k DeepSeek
 * doesn't drown in one giant read_file but a 200 k Claude can comfortably
 * inspect it.
 */
export function tokenBudgetFor(modelId) {
  const m = lookupModel(modelId)
  // 4 chars per token rough estimate; we let one tool result eat at most
  // ~1/15 of the window in head+tail combined.
  const charsPerToken = 4
  const slice = Math.round((m.ctx / 15) * charsPerToken)
  return {
    head: Math.max(2000, Math.min(20000, Math.round(slice * 0.7))),
    tail: Math.max(800, Math.min(8000, Math.round(slice * 0.3))),
    ctxTokens: m.ctx,
    tier: m.tier,
    vision: m.vision,
  }
}

export function renderModelHintForPrompt(modelId) {
  const m = lookupModel(modelId)
  return [
    '# Runtime self-knowledge',
    '',
    `You are running as **${m.id}**.`,
    `Context window ≈ ${m.ctx.toLocaleString()} tokens.`,
    `Vision input: ${m.vision ? 'yes' : 'no'}.`,
    'When asked to read large files, summarise / extract relevant ranges with read_file + search_files instead of dumping the whole thing.',
  ].join('\n')
}
