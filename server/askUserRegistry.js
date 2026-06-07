/**
 * Shared registry of pending `ask_user` tool invocations.
 *
 * When the agent loop calls the `ask_user` tool, it doesn't execute
 * anything — instead it:
 *   1. Generates a question_id
 *   2. Emits an SSE 'ask_user' event with {question_id, spec}
 *   3. Awaits the promise stored under that id (with a long timeout)
 *
 * The client's UI renders the question card. When the user submits an
 * answer, the client POSTs it to `/api/agent/answer` with the
 * question_id, which resolves the promise here. The loop then receives
 * the answer and feeds it back to the LLM as the tool's result.
 *
 * Pending questions older than ASK_TIMEOUT_MS auto-reject so we don't
 * leak memory on abandoned conversations.
 */
const PENDING = new Map()      // id -> {resolve, reject, createdAt}
const ASK_TIMEOUT_MS = 10 * 60 * 1000  // 10 min

function genId() {
  return 'ask-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

export function registerQuestion() {
  const id = genId()
  let resolveFn, rejectFn
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  const timer = setTimeout(() => {
    if (PENDING.has(id)) {
      PENDING.delete(id)
      rejectFn(new Error('ask_user timeout: user did not answer within 10 minutes'))
    }
  }, ASK_TIMEOUT_MS)
  timer.unref?.()
  PENDING.set(id, { resolve: resolveFn, reject: rejectFn, createdAt: Date.now() })
  return { id, promise }
}

export function answerQuestion(id, answer) {
  const entry = PENDING.get(id)
  if (!entry) return false
  PENDING.delete(id)
  entry.resolve(answer)
  return true
}

export function cancelQuestion(id, reason = 'cancelled') {
  const entry = PENDING.get(id)
  if (!entry) return false
  PENDING.delete(id)
  entry.reject(new Error(reason))
  return true
}

export function pendingCount() {
  return PENDING.size
}
