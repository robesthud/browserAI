/**
 * Shared registry of pending `ask_user` / approval invocations.
 *
 * Lifecycle:
 *   running → waiting_for_user → answered/cancelled/timeout → running
 *
 * The registry stores metadata so the UI/debug endpoints can restore pending
 * questions for the current user/chat without exposing secrets.
 */
const PENDING = new Map()
const PENDING_TTL_MS = 30 * 60 * 1000  // 30 minutes
 // id -> {resolve,reject,timer,createdAt,expiresAt,meta,status}
const ASK_TIMEOUT_MS = Number(process.env.BROWSERAI_ASK_TIMEOUT_MS || 10 * 60 * 1000)

function genId() {
  return 'ask-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function publicEntry(id, entry) {
  if (!entry) return null
  return {
    id,
    status: entry.status || 'pending',
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    remainingMs: Math.max(0, entry.expiresAt - Date.now()),
    meta: entry.meta || {},
  }
}

export function registerQuestion(meta = {}) {
  const id = genId()
  const createdAt = Date.now()
  const timeoutMs = Math.min(
    60 * 60 * 1000,
    Math.max(5_000, Number(meta.timeoutMs || ASK_TIMEOUT_MS) || ASK_TIMEOUT_MS),
  )
  const expiresAt = createdAt + timeoutMs
  let resolveFn, rejectFn
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  const timer = setTimeout(() => {
    const entry = PENDING.get(id)
    if (entry) {
      PENDING.delete(id)
      entry.status = 'timeout'
      rejectFn(new Error(`ask_user timeout: user did not answer within ${Math.round(timeoutMs / 1000)} seconds`))
    }
  }, timeoutMs)
  timer.unref?.()
  PENDING.set(id, {
    resolve: resolveFn,
    reject: rejectFn,
    timer,
    createdAt,
    expiresAt,
    timeoutMs,
    status: 'pending',
    meta: {
      kind: meta.kind || 'ask_user',
      userId: meta.userId || '',
      chatId: meta.chatId || '',
      step: meta.step ?? null,
      sub: meta.sub ?? null,
      question: meta.question || '',
      options: Array.isArray(meta.options) ? meta.options : [],
      multi: Boolean(meta.multi),
      allowCustom: meta.allowCustom !== false,
      groupId: meta.groupId || undefined,
      tool: meta.tool || undefined,
      category: meta.category || undefined,
      argsPreview: meta.argsPreview || undefined,
    },
  })
  return { id, promise, expiresAt, timeoutMs }
}

export function answerQuestion(id, answer, scope = {}) {
  const entry = PENDING.get(id)
  if (!entry) return false
  if (scope.userId && entry.meta?.userId && scope.userId !== entry.meta.userId) return false
  clearTimeout(entry.timer)
  PENDING.delete(id)
  entry.status = 'answered'
  entry.resolve({
    ...(answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : { value: answer }),
    answeredAt: Date.now(),
  })
  return true
}

export function cancelQuestion(id, reason = 'cancelled', scope = {}) {
  const entry = PENDING.get(id)
  if (!entry) return false
  if (scope.userId && entry.meta?.userId && scope.userId !== entry.meta.userId) return false
  clearTimeout(entry.timer)
  PENDING.delete(id)
  entry.status = 'cancelled'
  entry.reject(new Error(reason))
  return true
}

export function listPendingQuestions(filter = {}) {
  const out = []
  for (const [id, entry] of PENDING.entries()) {
    if (filter.userId && entry.meta?.userId && entry.meta.userId !== filter.userId) continue
    if (filter.chatId && entry.meta?.chatId && entry.meta.chatId !== filter.chatId) continue
    out.push(publicEntry(id, entry))
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export function getPendingQuestion(id, scope = {}) {
  const entry = PENDING.get(id)
  if (!entry) return null
  if (scope.userId && entry.meta?.userId && scope.userId !== entry.meta.userId) return null
  return publicEntry(id, entry)
}

export function pendingCount(filter = {}) {
  return listPendingQuestions(filter).length
}
// ── Expired question cleanup ───────────────────────────────────────────────
function cleanupExpiredQuestions() {
  const now = Date.now()
  let evicted = 0
  for (const [id, q] of PENDING) {
    if (now - (q.createdAt || 0) > PENDING_TTL_MS) {
      try { q.reject?.(new Error('Question expired after 30 min')) } catch {}
      PENDING.delete(id)
      evicted++
    }
  }
  if (evicted) console.warn(`[askUser] expired ${evicted} unanswered questions`)
}
setInterval(cleanupExpiredQuestions, 5 * 60 * 1000).unref?.()
