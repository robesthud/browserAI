/**
 * architectEditor.js
 *
 * Aider-style two-model routing: a STRONG "architect" model plans the
 * change (which files to touch, what the diff conceptually should be);
 * a CHEAP "editor" model produces the actual edit_file/write_file tool
 * calls. Saves 30-60% spend on long sessions.
 *
 * Strategy:
 *   For each agent turn we look at the SHAPE of the work the model is
 *   about to do:
 *     - "planning" turn  → bash/list_files/read_file/search_files/web_search
 *                          (gathering context)  → keep current model
 *     - "executing" turn → edit_file/write_file
 *                          (mechanical changes) → downgrade to cheap sibling
 *
 * We never change the model for the FIRST turn (model still needs to
 * reason about the request) and never for the FINAL summary (final
 * prose quality matters). Only mid-conversation "mechanical" turns get
 * the cheap router.
 *
 * Toggle:
 *   • Per-user via user_facts key `architect_mode` = 'on' | 'off' | 'auto'
 *   • Global default: env BROWSERAI_ARCHITECT_MODE = 'auto' (default 'off')
 *
 * Public:
 *   shouldUseCheapEditor({step, lastUserText, recentToolHistory, userId})
 *      → { useCheap: boolean, cheapModel: string|null, reason: string }
 *   wrapProviderForEditor(provider, cheapModel)
 *      → returns a shallow clone of provider with model swapped
 */
import dbHandle from './db.js'
import { suggestCheapSibling } from './modelKnowledge.js'

function userMode(userId = '') {
  try {
    const r = dbHandle.prepare(`SELECT value FROM user_facts
      WHERE user_id = ? AND key = 'architect_mode'`).get(String(userId || ''))
    if (r?.value) return String(r.value).toLowerCase()
  } catch { /* table may not exist */ }
  return String(process.env.BROWSERAI_ARCHITECT_MODE || 'off').toLowerCase()
}

const MECHANICAL_TOOLS = new Set([
  'edit_file', 'write_file', 'delete_file',
  // pure mechanical git wrappers — no planning needed:
  'git_status',
])

const PLANNING_TOOLS = new Set([
  'plan_set', 'plan_check',
  'web_search', 'web_fetch',
  'kb_search', 'recall_facts',
  'ask_user',
])

/**
 * Decide if we should swap to the cheap sibling for the NEXT LLM call.
 */
export function shouldUseCheapEditor({
  provider,
  step = 1,
  recentToolHistory = [],
  userId = '',
} = {}) {
  if (!provider?.model) return { useCheap: false }
  const mode = userMode(userId)
  if (mode === 'off') return { useCheap: false, reason: 'mode=off' }

  // Never downgrade on the first turn (still figuring out the task).
  if (step <= 1) return { useCheap: false, reason: 'first turn — keep strong model' }

  const cheapModel = suggestCheapSibling(provider.model)
  if (!cheapModel || cheapModel === provider.model) return { useCheap: false, reason: 'no cheap sibling known' }

  // In 'on' mode → always downgrade after step 1.
  if (mode === 'on') {
    return { useCheap: true, cheapModel, reason: 'mode=on (forced)' }
  }

  // 'auto' mode → look at what the model was just doing.
  // If the last 1-2 turns were mechanical edits, the NEXT turn is likely
  // either another mechanical edit OR a finish. Both are fine on cheap.
  const lastN = recentToolHistory.slice(-3)
  if (!lastN.length) return { useCheap: false, reason: 'no tool history yet' }

  const mechanicalCount = lastN.filter((t) => MECHANICAL_TOOLS.has(t.tool || t.name)).length
  const planningCount   = lastN.filter((t) => PLANNING_TOOLS.has(t.tool || t.name)).length

  // Heuristic: ≥2 of the last 3 calls were mechanical → swap.
  if (mechanicalCount >= 2 && planningCount === 0) {
    return { useCheap: true, cheapModel, reason: `mechanical streak (${mechanicalCount}/3)` }
  }
  return { useCheap: false, reason: 'mixed — keep strong model' }
}

export function wrapProviderForEditor(provider, cheapModel) {
  if (!cheapModel) return provider
  return { ...provider, model: cheapModel }
}

/**
 * For UI badge: a short label of the routing decision this turn.
 */
export function routingLabel(decision = {}) {
  if (decision.useCheap) return `↘ editor:${decision.cheapModel}`
  return null
}

export default { shouldUseCheapEditor, wrapProviderForEditor, routingLabel }
