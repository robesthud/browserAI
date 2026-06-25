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
import dbHandle, { listKeys } from './db.js'
import { suggestCheapSibling, suggestStrongSibling } from './modelKnowledge.js'

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

/**
 * Package I: Reviewer model — switch to strong sibling for reflection/review turns.
 * Called when agent is about to do a final review of changes (post-verify step).
 * Returns { useStrong, strongModel, reason } 
 */
export function reviewerModelFor({ provider, recentToolHistory = [], step = 1 } = {}) {
  if (!provider?.model) return { useStrong: false }
  // Only upgrade on reflection/review turns (after verify or test pass)
  const recentOk = recentToolHistory.slice(-3)
  const hasVerify = recentOk.some(h => h.ok && (h.semantic?.isVerify || h.semantic?.isLocalTest))
  const hasCodeChange = recentOk.some(h => h.ok && (h.semantic?.isWrite || h.semantic?.isEdit))
  if (!hasVerify || !hasCodeChange || step < 3) return { useStrong: false, reason: 'no verify evidence yet' }
  
  const strongModel = suggestStrongSibling(provider.model)
  if (strongModel && strongModel !== provider.model) {
    return { useStrong: true, strongModel, reason: `reflection turn — upgrade to strong sibling ${strongModel}` }
  }
  return { useStrong: false, reason: 'no stronger sibling known' }
}

export default { shouldUseCheapEditor, wrapProviderForEditor, routingLabel, reviewerModelFor }

export function getAutopilotModelForTurn({ step = 1, recentToolHistory = [], userId = '' } = {}) {
  let keys = []
  try {
    keys = listKeys()
  } catch (e) {
    console.warn('[Autopilot Router] DB query failed:', e.message)
    return null
  }

  // Gather all available models across all configured keys
  const allAvailableModels = new Set()
  for (const k of keys) {
    if (k.availableModels && Array.isArray(k.availableModels)) {
      for (const m of k.availableModels) {
        allAvailableModels.add(String(m).toLowerCase())
      }
    }
    if (k.model) {
      allAvailableModels.add(String(k.model).toLowerCase())
    }
  }

  const isReflectionTurn = recentToolHistory.slice(-1).some(h => h.ok && (h.semantic?.isVerify || h.semantic?.isLocalTest))

  if (step === 1 || isReflectionTurn) {
    if (allAvailableModels.has('deepseek-reasoner')) return 'deepseek-reasoner'
    if (allAvailableModels.has('glm-5.2')) return 'glm-5.2'
    if (allAvailableModels.has('glm-4.7')) return 'glm-4.7'
    if (allAvailableModels.has('deepseek_chat')) return 'deepseek_chat'
    return null
  }

  if (allAvailableModels.has('glm-4.7-flash')) return 'glm-4.7-flash'
  if (allAvailableModels.has('glm-4.6v-flash')) return 'glm-4.6v-flash'
  if (allAvailableModels.has('qwen2.5-coder:1.5b')) return 'qwen2.5-coder:1.5b'
  return null
}
