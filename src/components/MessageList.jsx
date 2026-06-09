import { useEffect, useRef, useState } from 'react'
import { IconBot, IconUser, IconFile, IconCopy, IconEdit, IconRefresh } from '../icons.jsx'
import { formatSize } from '../lib/files.js'
import Markdown from '../lib/markdown.jsx'
import AgentToolBlock from './AgentToolBlock.jsx'
import AgentThought from './AgentThought.jsx'
import AgentPlanCard from './AgentPlanCard.jsx'
import AgentExtendedThinking from './AgentExtendedThinking.jsx'
import AgentAskUser from './AgentAskUser.jsx'
import AgentRuntimePanel from './AgentRuntimePanel.jsx'
import JobCard from './JobCard.jsx'
import usePullToRefresh from '../lib/usePullToRefresh.js'
import useSwipeActions from '../lib/useSwipeActions.js'

function devtoolsEnabled() {
  try { return localStorage.getItem('browserai.devtools') === '1' }
  catch { return false }
}

function Attachments({ items }) {
  if (!items?.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-graphite-900/60 px-2.5 py-1.5 text-[12px] text-cream-soft"
        >
          {a.dataUrl && a.type.startsWith('image/') ? (
            <img
              src={a.dataUrl}
              alt={a.name}
              className="h-8 w-8 rounded object-cover"
            />
          ) : (
            <span className="text-cream-dim">
              <IconFile />
            </span>
          )}
          <span className="max-w-[160px] truncate">{a.name}</span>
          <span className="text-cream-faint">{formatSize(a.size)}</span>
        </div>
      ))}
    </div>
  )
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          // Clipboard API: работает на HTTPS и в современных WebView
          // Fallback через execCommand для старых Android WebView
          try {
            await navigator.clipboard.writeText(text)
          } catch {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
            document.body.appendChild(ta)
            ta.focus()
            ta.select()
            document.execCommand('copy')
            ta.remove()
          }
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {
          /* ignore */
        }
      }}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-cream-faint
                 opacity-0 transition-opacity hover:text-cream group-hover:opacity-100"
      title="Скопировать"
    >
      <IconCopy />
      {done ? 'Скопировано' : 'Копировать'}
    </button>
  )
}

function friendlyAssistantError(message = '', providerError = null) {
  if (providerError?.hint) return providerError.hint
  const raw = String(message || '')
  const lower = raw.toLowerCase()
  if (/401|403|unauthorized|forbidden|invalid api key|invalid token/.test(lower)) return 'Проблема авторизации: проверь ключ или токен провайдера.'
  if (/429|rate limit|quota|лимит|квота/.test(lower)) return 'Провайдер ограничил запросы или квоту. Попробуй позже или выбери другой ключ.'
  if (/timeout|timed out|aborted|таймаут/.test(lower)) return 'Провайдер не ответил вовремя. Можно повторить запрос.'
  if (/model|not found|unknown|invalid/.test(lower)) return 'Модель недоступна или указана неверно. Проверь выбранную модель.'
  if (/network|fetch|bad gateway|service unavailable|502|503/.test(lower)) return 'Сетевая ошибка или временный сбой провайдера.'
  return raw ? raw.slice(0, 240) : 'Агент столкнулся с ошибкой.'
}

function WorkingSpinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cream/25 border-t-cream"
      aria-label="AI работает"
      title="AI работает"
    />
  )
}

function Message({ m, isLast, aiWorking, onEdit, onRegenerate, onAnswerAskUser, onCancelAskUser, onJobDone, onBranch }) {
  const isUser = m.role === 'user'
  const isDev = devtoolsEnabled()
  const hasAgentActivity = !isUser && Boolean(
    (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) ||
    (Array.isArray(m.askUsers) && m.askUsers.length > 0) ||
    (Array.isArray(m.thoughts) && m.thoughts.length > 0) ||
    m.thinking ||
    m.job,
  )

  // Mobile swipe-left -> reveal action buttons (regenerate / copy).
  // The hook is a no-op on desktop because there are no touch events.
  const swipe = useSwipeActions()

  const copyMessage = async () => {
    try { await navigator.clipboard.writeText(m.content || '') } catch { /* clipboard unavailable */ }
    swipe.reset()
  }

  return (
    <div className="group relative overflow-hidden">
      {/* Action panel revealed behind the message on swipe-left */}
      {(swipe.open || swipe.offset < -2) && (
        <div className="pointer-events-auto absolute inset-y-0 right-0 z-0 flex items-center gap-1 bg-graphite-900 px-2">
          {m.content && (
            <button
              onClick={copyMessage}
              className="grid h-9 w-9 place-items-center rounded-full bg-graphite-700 text-cream-soft hover:bg-graphite-600"
              title="Копировать"
            >
              <IconCopy />
            </button>
          )}
          {!isUser && onRegenerate && (
            <button
              onClick={() => { onRegenerate(m); swipe.reset() }}
              disabled={aiWorking}
              className="grid h-9 w-9 place-items-center rounded-full bg-graphite-700 text-cream-soft hover:bg-graphite-600 disabled:opacity-40"
              title="Сгенерировать заново"
            >
              <IconRefresh />
            </button>
          )}
          {isUser && onEdit && (
            <button
              onClick={() => { onEdit(m); swipe.reset() }}
              className="grid h-9 w-9 place-items-center rounded-full bg-graphite-700 text-cream-soft hover:bg-graphite-600"
              title="Редактировать"
            >
              <IconEdit />
            </button>
          )}
        </div>
      )}

      <div
        {...swipe.bind}
        style={{ transform: `translateX(${swipe.offset}px)`, transition: swipe.offset === 0 || swipe.open ? 'transform 0.2s ease' : 'none' }}
        className="relative z-10 flex gap-3 bg-graphite-900 px-4 py-5"
      >
      <div
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full
          ${isUser ? 'bg-graphite-600 text-cream' : 'bg-cream text-graphite-900'}`}
      >
        {isUser ? <IconUser /> : <IconBot />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[13px] font-medium text-cream flex items-center gap-2">
            {isUser ? 'Вы' : 'Ассистент'}
            {!isUser && isLast && aiWorking && <WorkingSpinner />}
          </span>
          {m.content && !m.pending && <CopyButton text={m.content} />}
          {isUser && onEdit && (
             <button onClick={() => onEdit(m)} className="opacity-0 group-hover:opacity-100 transition-opacity text-cream-faint hover:text-cream px-1" title="Редактировать">
               <IconEdit />
             </button>
          )}
          {!isUser && onRegenerate && (
             <button onClick={() => onRegenerate(m)} disabled={aiWorking} className={`opacity-0 group-hover:opacity-100 transition-opacity text-cream-faint hover:text-cream px-1 ${aiWorking ? 'hidden' : ''}`} title="Сгенерировать заново">
               <IconRefresh />
             </button>
          )}
          {onBranch && !aiWorking && (
            <button
              onClick={() => onBranch(m.id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-cream-faint hover:text-cream px-1"
              title="Создать ветку из этого сообщения (новый чат с историей до сих пор)"
            >↳</button>
          )}
          {/* Per-message token badge for assistant turns */}
          {!isUser && m.tokens?.total ? (
            <span
              className="rounded-full border border-white/10 bg-graphite-800/40 px-1.5 font-mono text-[10px] text-cream-faint"
              title={`prompt: ${m.tokens.prompt || 0} · completion: ${m.tokens.completion || 0}`}
            >
              {m.tokens.total > 9999 ? `${(m.tokens.total / 1000).toFixed(1)}k` : m.tokens.total}t
            </span>
          ) : null}
        </div>

        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-cream-soft">
            {m.content}
          </p>
        ) : m.error && !hasAgentActivity ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
            <div>⚠ {friendlyAssistantError(m.error, m.providerError)}</div>
            {isDev && (m.providerError || m.error) && (
              <details className="mt-2 text-[11px] text-red-200/80">
                <summary className="cursor-pointer">debug details</summary>
                <pre className="thin-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 font-mono">
{JSON.stringify(m.providerError || { error: m.error }, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <div className="text-[14px] leading-relaxed text-cream-soft">
            {/* Provider-side extended thinking (Claude 3.7+, OpenAI o1/o3,
                DeepSeek R1). Auto-opens while streaming, folds when done.
                Distinct from the per-step `thoughts` narrative below. */}
            {m.thinking && isDev ? (
              <AgentExtendedThinking
                text={m.thinking}
                pending={Boolean(m.pending)}
                tokens={Number(m.tokens?.reasoningTokens || 0)}
              />
            ) : null}
            {m.thinking && !isDev && m.pending ? (
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-graphite-800/60 px-2.5 py-1 text-[12px] text-cream-faint">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-300" />
                <span>Агент размышляет…</span>
              </div>
            ) : null}
            {isDev && (
              <AgentRuntimePanel
                context={m.agentContext}
                state={m.agentState}
                protocol={m.streamProtocol}
                routerWarnings={m.routerWarnings || []}
              />
            )}

            {/* Agent loop: interleave intermediate thoughts and tool calls by step,
                so the UI shows the model planning before each action — same UX as
                Cursor / Arena. */}
            {(Array.isArray(m.toolCalls) && m.toolCalls.length > 0) || (Array.isArray(m.thoughts) && m.thoughts.length > 0) ? (
              <div className="mb-2 space-y-1">
                {(() => {
                  // ─── Pass 1: fold plan_set + plan_check calls into a single
                  // PlanCard so we don't show 5 separate toolblocks for what
                  // is really one checklist. The card lives at the TOP of
                  // the message and updates as plan_check arrives.
                  let plan = null
                  for (const tc of m.toolCalls || []) {
                    if (tc.status !== 'done' || !tc.ok) continue
                    if (tc.name === 'plan_set' && Array.isArray(tc.result?.plan)) {
                      plan = { title: tc.result.title || '', steps: tc.result.plan.map((s) => ({ ...s })) }
                    } else if (tc.name === 'plan_check' && plan && Array.isArray(tc.result?.checked)) {
                      for (const i of tc.result.checked) {
                        const idx = Number(i)
                        const step = plan.steps.find((s) => s.idx === idx)
                        if (step) {
                          step.done = true
                          if (tc.result.note) step.note = tc.result.note
                        }
                      }
                    }
                  }

                  // ─── Pass 2: progress counter "Step N of M" — purely
                  // cosmetic, derived from how many distinct tool steps
                  // have completed vs how many are still running.
                  const stepIds = new Set()
                  let doneSteps = 0
                  for (const tc of m.toolCalls || []) {
                    if (tc.name === 'plan_set' || tc.name === 'plan_check') continue
                    stepIds.add(tc.step)
                    if (tc.status === 'done') doneSteps += 1
                  }
                  const totalSteps = stepIds.size

                  const items = []
                  if (plan) items.push(<AgentPlanCard key="plan" plan={plan} />)
                  if (isDev && totalSteps > 1 && aiWorking) {
                    items.push(
                      <div key="step-progress" className="px-1 text-[11px] text-cream-faint">
                        Шаг {doneSteps} из {totalSteps}…
                      </div>,
                    )
                  }

                  const thoughtsByStep = new Map()
                  for (const t of m.thoughts || []) {
                    if (!thoughtsByStep.has(t.step)) thoughtsByStep.set(t.step, [])
                    thoughtsByStep.get(t.step).push(t)
                  }
                  for (const tc of m.toolCalls || []) {
                    const ths = thoughtsByStep.get(tc.step) || []
                    if (isDev) {
                      for (const t of ths) {
                        items.push(
                          <AgentThought key={`th-${tc.step}-${t.at}`} text={t.text} />,
                        )
                      }
                    }
                    thoughtsByStep.delete(tc.step)
                    // Hide plan_set / plan_check tool blocks themselves —
                    // they're already represented by AgentPlanCard above.
                    if (tc.name === 'plan_set' || tc.name === 'plan_check') continue
                    items.push(
                      <AgentToolBlock
                        key={tc.id}
                        step={tc.step}
                        name={tc.name}
                        args={tc.args}
                        status={tc.status}
                        ok={tc.ok}
                        result={tc.result}
                        error={tc.error}
                        startedAt={tc.startedAt}
                        finishedAt={tc.finishedAt}
                        stream={tc.stream}
                        diagnostic={tc.diagnostic}
                      />,
                    )
                  }
                  // any leftover thoughts (no matching tool) — render at the end
                  for (const [step, ths] of thoughtsByStep) {
                    if (isDev) {
                      for (const t of ths) {
                        items.push(
                          <AgentThought key={`th-late-${step}-${t.at}`} text={t.text} />,
                        )
                      }
                    }
                  }
                  return items
                })()}
              </div>
            ) : null}

            {/* ask_user cards (multi-select questions from the agent) */}
            {Array.isArray(m.askUsers) && m.askUsers.length > 0 && (
              <div className="space-y-1">
                {m.askUsers.map((q) => (
                  <AgentAskUser
                    key={q.id}
                    question={q.question}
                    options={q.options}
                    multi={q.multi}
                    allowCustom={q.allowCustom}
                    answered={q.answered}
                    answer={q.answer}
                    expiresAt={q.expiresAt}
                    kind={q.kind || 'question'}
                    tool={q.tool || ''}
                    category={q.category || ''}
                    args={q.args || null}
                    onSubmit={(payload) => onAnswerAskUser?.(q.id, payload)}
                    onCancel={() => onCancelAskUser?.(q.id)}
                  />
                ))}
              </div>
            )}

            {m.error && hasAgentActivity ? (
              <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
                <div>⚠ {friendlyAssistantError(m.error, m.providerError)}</div>
                {isDev && (m.providerError || m.error) && (
                  <details className="mt-2 text-[11px] text-red-200/80">
                    <summary className="cursor-pointer">debug details</summary>
                    <pre className="thin-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 font-mono">
{JSON.stringify(m.providerError || { error: m.error }, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ) : null}

            {m.job ? <JobCard job={m.job} onJobDone={onJobDone} /> : null}

            {m.content ? (
              <div className={hasAgentActivity ? 'mt-3 border-t border-white/10 pt-3' : ''}>
                <Markdown text={m.content} />
              </div>
            ) : null}

            {m.pending && hasAgentActivity && !m.content && !(m.job && ['succeeded', 'failed', 'cancelled'].includes(m.job.status)) && (
              <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-graphite-800/60 px-2.5 py-1 text-[12px] text-cream-faint">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
                <span>Агент выполняет действия…</span>
              </div>
            )}

            {/*
              Hide the pulsing cursor when the message owns a job that has
              already reached a terminal state (succeeded / failed / cancelled),
              or while an agent is only showing tool/action progress. The
              final answer gets its own Markdown block once text arrives.
            */}
            {m.pending && !hasAgentActivity && !(m.job && ['succeeded', 'failed', 'cancelled'].includes(m.job.status)) && (
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-cream/70 align-middle" />
            )}
            {m.stopped && !m.content && (
              <div className="mt-2 rounded-lg border border-white/10 bg-graphite-800/40 px-3 py-2 text-[12px] italic text-cream-faint">
                — генерация остановлена
              </div>
            )}

            {!m.pending && !m.stopped && hasAgentActivity && !m.content && !m.error && !(m.job && ['succeeded', 'failed', 'cancelled'].includes(m.job.status)) && (
              <div className="mt-2 rounded-lg border border-white/10 bg-graphite-800/40 px-3 py-2 text-[12px] text-cream-faint">
                Агент завершил действия без итогового ответа.
              </div>
            )}
          </div>
        )}

        <Attachments items={m.attachments} />
      </div>
      </div>
    </div>
  )
}

export default function MessageList({ messages, aiWorking, onEdit, onRegenerate, onRefresh, onAnswerAskUser, onCancelAskUser, onJobDone, onBranch }) {
  const bottomRef = useRef(null)
  const scrollRef = useRef(null)
  const prevLenRef = useRef(messages.length)
  // True if the user has scrolled up (>200px from bottom). While true we
  // STOP auto-scrolling on every streamed token, so the user can quietly
  // read older messages while the model is still writing.
  // Cleared as soon as the user scrolls back down to within 60px of the
  // bottom (or sends a new message).
  const userScrolledUpRef = useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const { pullDistance, refreshing, threshold } = usePullToRefresh(scrollRef, onRefresh)

  // Track manual scroll position so we can stop fighting the user.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      // 60px hysteresis: if you scroll back almost to the bottom, we
      // consider you "caught up" and resume auto-scroll on the next chunk.
      if (distance < 60) {
        userScrolledUpRef.current = false
        setShowJumpToLatest(false)
      } else if (distance > 200) {
        userScrolledUpRef.current = true
        if (aiWorking) setShowJumpToLatest(true)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [aiWorking])

  // When AI is no longer working, hide the "jump to latest" button.
  useEffect(() => {
    if (!aiWorking) setShowJumpToLatest(false)
  }, [aiWorking])

  // Scroll to bottom only when a NEW message appears (not on chunk updates).
  // User just hit "send" → assume they want to see the assistant reply.
  useEffect(() => {
    const prevLen = prevLenRef.current
    prevLenRef.current = messages.length
    if (messages.length > prevLen) {
      userScrolledUpRef.current = false   // reset on new turn
      setShowJumpToLatest(false)
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length])

  // Auto-scroll on streamed content/tool growth — but ONLY if the user
  // hasn't deliberately scrolled up. Uses behavior:'auto' (instant) so
  // we don't stack dozens of in-flight smooth animations that would
  // otherwise lock the scroll position.
  const lastMsg = messages[messages.length - 1]
  const lastToolCount = (lastMsg?.toolCalls?.length || 0) + (lastMsg?.thoughts?.length || 0)
  useEffect(() => {
    if (userScrolledUpRef.current) return
    const el = scrollRef.current
    if (!el) return
    // Only follow the stream if we were ALREADY near the bottom; a sudden
    // jump down while the user is mid-read is the bug we fixed.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance > 200) return
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [lastToolCount, lastMsg?.content])

  const armed = pullDistance >= threshold

  const jumpToLatest = () => {
    userScrolledUpRef.current = false
    setShowJumpToLatest(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div ref={scrollRef} className="thin-scroll relative flex-1 overflow-y-auto">
      {/* Pull-to-refresh indicator */}
      {(pullDistance > 0 || refreshing) && (
        <div
          className="pointer-events-none sticky top-0 z-10 flex items-center justify-center text-[12px] text-cream-faint transition-all"
          style={{ height: refreshing ? 40 : pullDistance, opacity: Math.min(1, pullDistance / threshold) }}
        >
          {refreshing
            ? <span className="animate-spin">⟳</span>
            : <span className={armed ? 'text-cream' : ''}>{armed ? '↑ Отпусти, чтобы обновить' : '↓ Потяни, чтобы обновить'}</span>}
        </div>
      )}

      <div className="mx-auto w-full max-w-2xl divide-y divide-white/[0.04]">
        {messages.map((m, i) => (
          <Message
            key={m.id}
            m={m}
            isLast={i === messages.length - 1}
            aiWorking={aiWorking}
            onEdit={onEdit}
            onRegenerate={onRegenerate}
            onJobDone={onJobDone}
            onBranch={onBranch}
            onAnswerAskUser={(questionId, payload) => onAnswerAskUser?.(m.id, questionId, payload)}
            onCancelAskUser={(questionId) => onCancelAskUser?.(m.id, questionId)}
          />
        ))}
      </div>
      <div ref={bottomRef} className="h-4" />

      {/* Floating "jump to latest" pill — appears when the user scrolled
          up during streaming. Clicking re-enables auto-follow. */}
      {showJumpToLatest && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="sticky bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-full border border-white/15 bg-graphite-800/95 px-3 py-1.5 text-[12px] text-cream shadow-lg backdrop-blur hover:bg-graphite-700"
          style={{ marginLeft: 'auto', marginRight: 'auto', width: 'fit-content' }}
        >
          ↓ К последнему ответу
        </button>
      )}
    </div>
  )
}
