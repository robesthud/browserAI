import { useEffect, useRef, useState } from 'react'
import { IconBot, IconUser, IconFile, IconCopy, IconEdit, IconRefresh } from '../icons.jsx'
import { formatSize } from '../lib/files.js'
import Markdown from '../lib/markdown.jsx'
import AgentToolBlock from './AgentToolBlock.jsx'
import AgentAskUser from './AgentAskUser.jsx'
import JobCard from './JobCard.jsx'
import usePullToRefresh from '../lib/usePullToRefresh.js'
import useSwipeActions from '../lib/useSwipeActions.js'

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

function WorkingSpinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cream/25 border-t-cream"
      aria-label="AI работает"
      title="AI работает"
    />
  )
}

function Message({ m, isLast, aiWorking, onEdit, onRegenerate, onAnswerAskUser }) {
  const isUser = m.role === 'user'

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
        </div>

        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-cream-soft">
            {m.content}
          </p>
        ) : m.error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
            ⚠ {m.error}
          </div>
        ) : (
          <div className="text-[14px] leading-relaxed text-cream-soft">
            {/* Agent loop: interleave intermediate thoughts and tool calls by step,
                so the UI shows the model planning before each action — same UX as
                Cursor / Arena. */}
            {(Array.isArray(m.toolCalls) && m.toolCalls.length > 0) || (Array.isArray(m.thoughts) && m.thoughts.length > 0) ? (
              <div className="mb-2 space-y-1">
                {(() => {
                  const items = []
                  const thoughtsByStep = new Map()
                  for (const t of m.thoughts || []) {
                    if (!thoughtsByStep.has(t.step)) thoughtsByStep.set(t.step, [])
                    thoughtsByStep.get(t.step).push(t)
                  }
                  for (const tc of m.toolCalls || []) {
                    const ths = thoughtsByStep.get(tc.step) || []
                    for (const t of ths) {
                      items.push(
                        <div key={`th-${tc.step}-${t.at}`} className="text-[13px] text-cream-soft">
                          <Markdown text={t.text} />
                        </div>,
                      )
                    }
                    thoughtsByStep.delete(tc.step)
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
                      />,
                    )
                  }
                  // any leftover thoughts (no matching tool) — render at the end
                  for (const [step, ths] of thoughtsByStep) {
                    for (const t of ths) {
                      items.push(
                        <div key={`th-late-${step}-${t.at}`} className="text-[13px] text-cream-soft">
                          <Markdown text={t.text} />
                        </div>,
                      )
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
                    onSubmit={(payload) => onAnswerAskUser?.(q.id, payload)}
                  />
                ))}
              </div>
            )}

            {m.job ? <JobCard job={m.job} /> : null}
            {m.content ? <Markdown text={m.content} /> : null}
            {m.pending && (
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-cream/70 align-middle" />
            )}
            {m.stopped && !m.content && (
              <span className="italic text-cream-faint">— генерация остановлена</span>
            )}
          </div>
        )}

        <Attachments items={m.attachments} />
      </div>
      </div>
    </div>
  )
}

export default function MessageList({ messages, aiWorking, onEdit, onRegenerate, onRefresh, onAnswerAskUser }) {
  const bottomRef = useRef(null)
  const scrollRef = useRef(null)
  const prevLenRef = useRef(messages.length)
  const { pullDistance, refreshing, threshold } = usePullToRefresh(scrollRef, onRefresh)

  // Скроллим вниз только когда появляется новое сообщение,
  // но НЕ при переключении чата из сайдбара (там длина может не меняться)
  useEffect(() => {
    const prevLen = prevLenRef.current
    prevLenRef.current = messages.length
    if (messages.length > prevLen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Auto-scroll when the last assistant message grows new tool calls or
  // thoughts (the agent loop streams them in). We don't want to fight
  // the user — only scroll if they're already close to the bottom.
  const lastMsg = messages[messages.length - 1]
  const lastToolCount = (lastMsg?.toolCalls?.length || 0) + (lastMsg?.thoughts?.length || 0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 200) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lastToolCount, lastMsg?.content])

  const armed = pullDistance >= threshold

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
            onAnswerAskUser={(questionId, payload) => onAnswerAskUser?.(m.id, questionId, payload)}
          />
        ))}
      </div>
      <div ref={bottomRef} className="h-4" />
    </div>
  )
}
