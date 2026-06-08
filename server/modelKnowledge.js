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
const RULES = [
  // OpenAI
  { match: /gpt-4o(-mini)?/i, ctx: 128_000, tier: 'expensive', vision: true },
  { match: /gpt-4(\.5|-turbo)?/i, ctx: 128_000, tier: 'expensive', vision: true },
  { match: /gpt-4o-realtime|o4-mini|o1-mini/i, ctx: 128_000, tier: 'cheap', vision: true },
  { match: /o1\b|o3\b/i, ctx: 200_000, tier: 'expensive', vision: true },
  // Anthropic
  { match: /claude.*(opus|3-7|sonnet-4|4-sonnet)/i, ctx: 200_000, tier: 'expensive', vision: true },
  { match: /claude.*(haiku|3-5)/i, ctx: 200_000, tier: 'cheap', vision: true },
  // Google Gemini
  { match: /gemini-2\.5-pro|gemini-1\.5-pro/i, ctx: 1_000_000, tier: 'expensive', vision: true },
  { match: /gemini.*flash/i, ctx: 1_000_000, tier: 'cheap', vision: true },
  // DeepSeek
  { match: /deepseek.*reasoner|r1/i, ctx: 64_000, tier: 'expensive', vision: false },
  { match: /deepseek/i, ctx: 64_000, tier: 'cheap', vision: false },
  // Qwen / Mistral / Llama
  { match: /qwen.*(72b|max|plus)/i, ctx: 128_000, tier: 'expensive', vision: false },
  { match: /qwen/i, ctx: 32_000, tier: 'cheap', vision: false },
  { match: /mistral-large|codestral/i, ctx: 32_000, tier: 'expensive', vision: false },
  { match: /llama-3\.[12]?-(70|405)b/i, ctx: 128_000, tier: 'expensive', vision: false },
  { match: /llama/i, ctx: 32_000, tier: 'cheap', vision: false },
]

export function lookupModel(modelId = '') {
  const id = String(modelId || '')
  for (const r of RULES) if (r.match.test(id)) {
    return { id, ctx: r.ctx, tier: r.tier, vision: r.vision }
  }
  return { id, ctx: 32_000, tier: 'cheap', vision: false }
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
