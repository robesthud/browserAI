import { memo, useEffect, useRef, useState } from 'react'
import { IconFile, IconCopy, IconEdit, IconRefresh, IconCheck } from '../icons.jsx'
import { formatSize } from '../lib/files.js'
import Markdown from '../lib/markdown.jsx'
import AgentToolBlock from './AgentToolBlock.jsx'
import AgentRuntimePanel from './AgentRuntimePanel.jsx'
import AgentThought from './AgentThought.jsx'
import AgentPlanCard from './AgentPlanCard.jsx'
import AgentExtendedThinking from './AgentExtendedThinking.jsx'
import AgentAskUser from './AgentAskUser.jsx'
import JobCard from './JobCard.jsx'
import SubAgentsPanel from './SubAgentsPanel.jsx'  // Sprint 4C
import AgentEvidenceBlock from './AgentEvidenceBlock.jsx'  // Approach 7 — Trust UX
import RunResumeCard from './RunResumeCard.jsx'  // Approach 7 — Stream resilience
import ResultFilesBlock from './ResultFilesBlock.jsx'
// import usePullToRefresh from '../lib/usePullToRefresh.js'
import useSwipeActions from '../lib/useSwipeActions.js'

// BUG-1 fix: useTTS defined after all imports (ESM requires imports at top)
// TTS hook — Web Speech Synthesis
function useTTS() {
  const speak = (text) => {
    if (!window.speechSynthesis || !text) return
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(String(text).slice(0, 3000))
    utt.lang = 'ru-RU'
    utt.rate = 1.0
    window.speechSynthesis.speak(utt)
  }
  const stop = () => window.speechSynthesis?.cancel?.()
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window
  return { speak, stop, supported }
}

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
          {a.dataUrl && typeof a.type === 'string' && a.type.startsWith('image/') ? (
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

async function copyTextBestEffort(text = '') {
  try {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return true
    }
  } catch {
    return false
  }
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyTextBestEffort(text)
        if (!ok) return
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-cream-faint
                 opacity-60 transition-opacity hover:text-cream"
      title="Скопировать"
      aria-label={done ? 'Скопировано' : 'Скопировать сообщение'}
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
  if (/400|bad request/.test(lower)) return 'Провайдер отклонил запрос (HTTP 400). Эта модель может не поддерживать вызов инструментов. Попробуй Claude, GPT-4, Gemini или DeepSeek.'
  if (/model|not found|unknown|invalid/.test(lower)) return 'Модель недоступна или указана неверно. Проверь выбранную модель.'
  if (/network|fetch|bad gateway|service unavailable|502|503/.test(lower)) return 'Сетевая ошибка или временный сбой провайдера.'
  return raw ? raw.slice(0, 240) : 'Агент столкнулся с ошибкой.'
}

function errorKind(message = '', providerError = null) {
  const raw = `${message || ''} ${providerError?.message || ''} ${providerError?.hint || ''}`.toLowerCase()
  if (/401|403|unauthorized|forbidden|invalid api key|invalid token/.test(raw)) return 'auth'
  if (/429|rate limit|quota|лимит|квота/.test(raw)) return 'quota'
  if (/timeout|timed out|aborted|таймаут/.test(raw)) return 'timeout'
  if (/network|fetch|bad gateway|service unavailable|502|503/.test(raw)) return 'network'
  return 'generic'
}

function ErrorActions({ kind, onRetry, onOpenSettings }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {onRetry && (
        <button type="button" onClick={onRetry} className="rounded-full border border-white/15 px-3 py-1 text-[12px] text-cream-soft hover:bg-white/5">Повторить</button>
      )}
      {(kind === 'auth' || kind === 'quota') && onOpenSettings && (
        <button type="button" onClick={onOpenSettings} className="rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1 text-[12px] text-amber-100 hover:bg-amber-400/15">Настройки</button>
      )}
    </div>
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

function splitRuntimeEvidence(content = '') {
  const raw = String(content || '')
  const marker = /\n---\s*\n### Runtime evidence/i
  const m = raw.match(marker)
  if (!m || m.index == null) return { main: raw, evidence: '' }
  return {
    main: raw.slice(0, m.index).trim(),
    evidence: raw.slice(m.index).replace(/^\n---\s*\n/i, '').trim(),
  }
}

function isUserFacingThought(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return false
  const lower = raw.toLowerCase()
  return !(
    /^tool\s+["'`]/i.test(raw) ||
    /not recommended in phase/i.test(raw) ||
    /proceeding with advisory/i.test(raw) ||
    /ошибка схемы/i.test(lower) ||
    /модель написала bash-блок/i.test(lower) ||
    /нет реального tool-вызова/i.test(lower) ||
    /антигаллюцинатор/i.test(lower) ||
    /^самопроверка[:：]/i.test(raw) ||
    (/schema/i.test(lower) && /tool/i.test(lower)) ||
    (/\bphase\b/i.test(raw) && /\b(discover|execute|verify|finalize)\b/i.test(raw)) ||
    /agent_state|stream_protocol|tool_router/i.test(lower)
  )
}

function Message({ m, chatId, aiWorking, onEdit, onRegenerate, onResumeRun, onOpenSettings, onAnswerAskUser, onCancelAskUser, onJobDone, onBranch }) {
  const isUser = m.role === 'user'
  const isDev = devtoolsEnabled()
  const hasAgentActivity = !isUser && Boolean(
    (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) ||
    (Array.isArray(m.askUsers) && m.askUsers.length > 0) ||
    (Array.isArray(m.thoughts) && m.thoughts.length > 0) ||
    m.thinking ||
    m.job,
  )
  const showsThinkingPill = !isUser && Boolean(m.thinking && !isDev && m.pending)

  // Mobile swipe-left -> reveal action buttons (regenerate / copy).
  // The hook is a no-op on desktop because there are no touch events.
  const { speak: ttsSpeak, supported: ttsSupported } = useTTS()
  const swipe = useSwipeActions()

  const copyMessage = async () => {
    await copyTextBestEffort(m.content || '')
    swipe.reset()
  }

  return (
    <div className="group relative overflow-hidden" data-message-id={m.id} data-role={m.role} style={{ touchAction: 'pan-y' }}>
      {/* Action panel revealed behind the message on swipe-left */}
      {(swipe.open || swipe.offset < -2) && (
        <div className="pointer-events-auto absolute inset-y-0 right-0 z-0 flex items-center gap-1 bg-graphite-900 px-2">
          {m.content && (
            <button
              type="button"
              onClick={copyMessage}
              className="grid h-9 w-9 place-items-center rounded-full bg-graphite-700 text-cream-soft hover:bg-graphite-600"
              title="Копировать"
            >
              <IconCopy />
            </button>
          )}
          {!isUser && onRegenerate && (
            <button
              type="button"
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
              type="button"
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
        className={`relative z-10 flex gap-2.5 bg-graphite-900 px-4 py-1.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
      >

      <div className={`min-w-0 max-w-[85%] ${isUser ? 'ml-auto text-right' : 'flex-1'}`}>
        {!isUser && (
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-cream-faint select-none">
            {m.tokens?.total ? (
              <span
                className="rounded-full border border-white/5 bg-graphite-800/40 px-1 font-mono text-[9px]"
                title={`prompt: ${m.tokens.prompt || 0} · completion: ${m.tokens.completion || 0}`}
              >
                {m.tokens.total > 9999 ? `${(m.tokens.total / 1000).toFixed(1)}k` : m.tokens.total}t
              </span>
            ) : null}
            <div className="opacity-60 hover:opacity-100 transition-opacity flex items-center gap-1 ml-1">
              {m.content && !m.pending && <CopyButton text={m.content} />}
              {!isUser && onRegenerate && (
                 <button type="button" onClick={() => onRegenerate(m)} disabled={aiWorking} className={`text-cream-faint hover:text-cream px-0.5 ${aiWorking ? 'hidden' : ''}`} title="Сгенерировать заново">
                   <IconRefresh />
                 </button>
              )}
              {onBranch && !aiWorking && (
                <button
                  type="button"
                  onClick={() => onBranch(m.id)}
                  className="text-cream-faint hover:text-cream px-0.5"
                  title="Создать ветку"
                >↳</button>
              )}
            </div>
          </div>
        )}

        {isUser ? (
          <div className="group/bubble inline-block max-w-full">
            <div className="relative inline-block max-w-full">
              {isUser && onEdit && (
                <button type="button" onClick={() => onEdit(m)} className="absolute left-[-26px] top-1/2 -translate-y-1/2 opacity-0 group-hover/bubble:opacity-100 transition-opacity text-cream-faint hover:text-cream px-1 hidden sm:block" title="Редактировать">
                  <IconEdit />
                </button>
              )}
              <div className="rounded-2xl rounded-tr-none bg-graphite-750 px-3 py-2 text-[14px] leading-relaxed text-cream text-left whitespace-pre-wrap break-words inline-block max-w-full shadow-sm">
                {m.content}
              </div>
            </div>
            <div className="mt-1 hidden items-center justify-end gap-1 opacity-0 transition-opacity sm:flex sm:group-hover/bubble:opacity-100">
              {m.content && <CopyButton text={m.content} />}
              {onEdit && (
                <button type="button" onClick={() => onEdit(m)} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-cream-faint hover:text-cream" title="Редактировать">
                  <IconEdit />
                  Изменить
                </button>
              )}
            </div>
          </div>
        ) : m.error && !hasAgentActivity ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300 text-left">
            <div>⚠ {friendlyAssistantError(m.error, m.providerError)}</div>
            <ErrorActions kind={errorKind(m.error, m.providerError)} onRetry={onRegenerate ? () => onRegenerate(m) : null} onOpenSettings={onOpenSettings} />
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
          <div className="text-[14px] leading-relaxed text-cream-soft text-left" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
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
              <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-graphite-800/20 px-2.5 py-0.5 text-[11px]">
                <span className="shimmer-text">Агент размышляет…</span>
              </div>
            ) : null}
            

            {/* Agent loop: interleave intermediate thoughts and tool calls by step,
                so the UI shows the model planning before each action — same UX as
                Cursor / Arena. */}
            {(Array.isArray(m.toolCalls) && m.toolCalls.length > 0) || (Array.isArray(m.thoughts) && m.thoughts.length > 0) ? (
              <div className="mb-2 space-y-1">
                {(() => {
                  const items = []

                  const normalizeThought = (value = '') => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()

                  // 1:1 Arena Parity: AgentRuntimePanel (debug state) is ONLY for devtools.
                  if (isDev && m.agentState) {
                    items.push(<AgentRuntimePanel key={`runtime-${m.id}`} context={m.agentContext} state={m.agentState} aiWorking={aiWorking} isDev={isDev} />)
                  }

                  // Plan logic: fold plan_set / consolidated plan actions into
                  // one checklist card instead of showing opaque plan tool rows.
                  let plan = m.agentState?.plan
                  const isPlanTool = (tc) => tc?.name === 'plan_set' || tc?.name === 'plan_check' || tc?.name === 'plan'
                  if (!plan) {
                    for (const tc of m.toolCalls || []) {
                      if (tc.status !== 'done' || !tc.ok) continue
                      const isPlanSet = tc.name === 'plan_set' || (tc.name === 'plan' && tc.args?.action === 'set')
                      const isPlanCheck = tc.name === 'plan_check' || (tc.name === 'plan' && tc.args?.action === 'check')
                      if (isPlanSet) {
                        const rawSteps = Array.isArray(tc.result?.plan)
                          ? tc.result.plan
                          : Array.isArray(tc.result?.steps)
                            ? tc.result.steps
                            : Array.isArray(tc.args?.steps)
                              ? tc.args.steps
                              : []
                        if (rawSteps.length) {
                          plan = {
                            title: tc.result?.title || tc.args?.title || 'План действий',
                            steps: rawSteps.map((s, idx) => ({
                              idx: Number(s?.idx ?? idx + 1),
                              text: String(s?.text || s?.title || s?.detail || s || ''),
                              done: Boolean(s?.done),
                              note: s?.note || '',
                            })).filter((s) => s.text),
                          }
                        }
                      } else if (isPlanCheck && plan && Array.isArray(plan.steps)) {
                        const checked = tc.result?.checked || tc.args?.indices || tc.args?.checked || []
                        for (const i of checked) {
                          const idx = Number(i)
                          const step = plan.steps.find((s) => Number(s.idx) === idx)
                          if (step) {
                            step.done = true
                            if (tc.result?.note) step.note = tc.result.note
                          }
                        }
                      }
                    }
                  }
                  if (plan?.steps?.length) {
                    items.push(<AgentPlanCard key={`plan-${m.id}`} plan={plan} />)
                  }

                  // Strict chronological timeline: thought event then the exact
                  // tool call that followed it. This avoids grouping by step in
                  // a way that can place several thoughts before several tools.
                  const recoveredRun = Boolean(m.content && !m.pending && !m.error)
                  const timeline = []
                  const seenThoughts = new Set()
                  let eventOrder = 0
                  for (const t of m.thoughts || []) {
                    if (!isDev && !isUserFacingThought(t.text)) continue
                    const norm = normalizeThought(t.text)
                    if (!norm || seenThoughts.has(norm)) continue
                    seenThoughts.add(norm)
                    timeline.push({
                      type: 'thought',
                      thought: t,
                      step: Number(t.step ?? 0),
                      sub: Number(t.sub ?? -1),
                      at: Number(t.at || 0),
                      order: eventOrder++,
                    })
                  }
                  for (const [idx, tc] of (m.toolCalls || []).entries()) {
                    if (isPlanTool(tc)) continue
                    timeline.push({
                      type: 'tool',
                      tool: tc,
                      step: Number(tc.step ?? 0),
                      sub: Number(tc.sub ?? idx),
                      at: Number(tc.startedAt || tc.finishedAt || 0),
                      order: eventOrder++,
                    })
                  }
                  const sortValue = (e) => e.at || ((Number.isFinite(e.step) ? e.step : 0) * 1000 + (Number.isFinite(e.sub) ? e.sub : 0))
                  timeline.sort((a, b) => {
                    const byTime = sortValue(a) - sortValue(b)
                    if (byTime) return byTime
                    const byStep = a.step - b.step
                    if (byStep) return byStep
                    const bySub = a.sub - b.sub
                    if (bySub) return bySub
                    if (a.type !== b.type) return a.type === 'thought' ? -1 : 1
                    return a.order - b.order
                  })

                  for (const event of timeline) {
                    if (event.type === 'thought') {
                      const t = event.thought
                      items.push(<AgentThought key={`th-${t.step ?? 'x'}-${t.sub ?? 'x'}-${t.at || event.order}`} text={t.text} />)
                    } else {
                      const tc = event.tool
                      items.push(
                        <AgentToolBlock
                          key={tc.id || `tool-${event.step}-${event.sub}-${event.order}`}
                          step={tc.step}
                          name={tc.name}
                          args={tc.args}
                          status={tc.status}
                          ok={tc.ok}
                          result={tc.result}
                          error={tc.error}
                          recovered={recoveredRun && tc.ok === false}
                          startedAt={tc.startedAt}
                          finishedAt={tc.finishedAt}
                          stream={tc.stream}
                          diagnostic={tc.diagnostic}
                          fileChanges={tc.fileChanges}
                          fileChangeSummary={tc.fileChangeSummary}
                          onRetry={(tool) => {
                            window.dispatchEvent(new CustomEvent('agent:retry-tool', {
                              detail: { name: tool.name, args: tool.args },
                            }))
                          }}
                        />,
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
                <ErrorActions kind={errorKind(m.error, m.providerError)} onRetry={onRegenerate ? () => onRegenerate(m) : null} onOpenSettings={onOpenSettings} />
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
            {/* Sprint 4C — sub-agents panel: shown when agent spawned child jobs */}
            {m.job?.id && <SubAgentsPanel parentJobId={m.job.id} className="mt-2" />}

            {m.content ? (() => {
              const parts = !isDev ? splitRuntimeEvidence(m.content) : { main: m.content, evidence: '' }
              return (
                <div className={hasAgentActivity ? 'final-answer mt-3 pt-1' : 'final-answer'}>
                  <Markdown text={parts.main || m.content} />
                  {ttsSupported && parts.main && (
                    <button
                      type="button"
                      onClick={() => ttsSpeak(parts.main || m.content)}
                      className="mt-1 inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-cream-faint hover:bg-graphite-750 hover:text-cream transition-colors"
                      title="Озвучить ответ"
                    >🔊 Озвучить</button>
                  )}
                  {!m.pending && !m.error ? <ResultFilesBlock toolCalls={m.toolCalls} chatId={chatId} /> : null}
                  {parts.evidence ? (
                    <details className="mt-3 rounded-lg border border-white/5 bg-graphite-800/20 text-[12px]">
                      <summary className="cursor-pointer px-2.5 py-1 text-cream-soft hover:bg-white/5">Подробности выполнения</summary>
                      <div className="px-2.5 py-1 text-cream-soft">
                        <Markdown text={parts.evidence} />
                      </div>
                    </details>
                  ) : null}
                </div>
              )
            })() : null}

            {/* Approach 7 — Trust UX. Structured evidence card from finalStatus. */}
            {m.finalStatus && !m.pending ? (
              <AgentEvidenceBlock finalStatus={m.finalStatus} />
            ) : null}

            {/* Approach 7 — Stream resilience. Resume card for interrupted runs. */}
            {m.finalStatus && !m.pending && ['crash', 'max-steps', 'deadline', 'llm-error'].includes(m.finalStatus.reason) ? (
              <RunResumeCard chatId={m.chatId || chatId || ''} reason={m.finalStatus.reason} onResume={onResumeRun} />
            ) : null}

            {/* Single clean pending indicator. Avoid stacking header spinner +
                body spinner + cursor (looked like two circles and a rectangle
                on mobile). Once thoughts/tools/content appear, their own UI is
                the progress indicator. */}
            {m.pending && !m.content && !hasAgentActivity && !showsThinkingPill && !(m.job && ['succeeded', 'failed', 'cancelled'].includes(m.job.status)) && (
              <div className="mt-2 flex items-center gap-2 text-cream-faint" aria-label="Агент работает">
                <WorkingSpinner />
              </div>
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
            
            {!isUser && !m.pending && !m.error && !m.stopped && <CheckpointBadge toolCalls={m.toolCalls} />}
          </div>
        )}

        <Attachments items={m.attachments} />
      </div>
      </div>
    </div>
  )
}

function cssEscapeValue(value = '') {
  try {
    if (window.CSS?.escape) return window.CSS.escape(String(value))
  } catch { /* ignore */ }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

const MemoMessage = memo(Message, (prev, next) => {
  // Old messages should not re-render on every streamed token of the latest
  // assistant reply. Ignore callback identity churn; message objects are
  // immutable in useChats, so reference equality is enough for content.
  return prev.m === next.m
    && prev.isLast === next.isLast
    && (!prev.isLast || prev.aiWorking === next.aiWorking)
})

function CheckpointBadge({ toolCalls }) {
  const hasWrite = (toolCalls || []).some(tc => 
    tc.ok && tc.status === 'done' && 
    (tc.name === 'write_file' || tc.name === 'edit_file' || tc.name === 'delete_file' || tc.name === 'replace_across_files')
  )
  if (!hasWrite) return null
  return (
    <div className="mt-3 flex items-center justify-end gap-1.5 opacity-60 transition-opacity hover:opacity-100">
      <span className="text-[10px] text-emerald-400"><IconCheck /></span>
      <span className="text-[10px] uppercase tracking-wider text-emerald-400">Снимок сохранён</span>
    </div>
  )
}

export default function MessageList({ messages, chatId = '', aiWorking, onEdit, onRegenerate, onResumeRun, onOpenSettings, onAnswerAskUser, onCancelAskUser, onJobDone, onBranch }) {
  const bottomRef = useRef(null)
  const scrollRef = useRef(null)
  const prevLenRef = useRef(messages.length)
  const prevLastUserIdRef = useRef([...messages].reverse().find((m) => m.role === 'user')?.id || '')
  const rafScrollRef = useRef(0)
  const manualScrollRef = useRef(false)
  // True if the user intentionally scrolled away from the live answer.
  // While true, streamed tokens/tool updates MUST NOT pull the viewport down.
  const userScrolledUpRef = useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [visibleCount, setVisibleCount] = useState(120)
  // pull-to-refresh disabled to prevent accidental page reload on mobile scroll
  // const { pullDistance, refreshing, threshold } = usePullToRefresh(scrollRef, onRefresh)
  const pullDistance = 0; const refreshing = false; const threshold = 999

  const scheduleScrollToBottom = (behavior = 'auto') => {
    cancelAnimationFrame(rafScrollRef.current)
    rafScrollRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
    })
  }

  const scrollToMessage = (messageId, behavior = 'smooth') => {
    cancelAnimationFrame(rafScrollRef.current)
    rafScrollRef.current = requestAnimationFrame(() => {
      const root = scrollRef.current
      if (!root || !messageId) return
      const node = root.querySelector(`[data-message-id="${cssEscapeValue(messageId)}"]`)
      if (!node) return
      // Put the freshly sent user message near the top third, ChatGPT-style,
      // so the user sees their request and the answer starts below it.
      const rootBox = root.getBoundingClientRect()
      const nodeBox = node.getBoundingClientRect()
      const offset = nodeBox.top - rootBox.top + root.scrollTop - 24
      root.scrollTo({ top: Math.max(0, offset), behavior })
    })
  }

  useEffect(() => () => cancelAnimationFrame(rafScrollRef.current), [])


  const disableAutoFollow = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance > 40) {
      userScrolledUpRef.current = true
      setShowJumpToLatest(true)
    }
  }

  // Manual interaction lock: as soon as the user touches/wheels/drags the
  // message list during streaming, stop fighting them. Auto-follow resumes
  // only when they scroll back to the bottom or press the jump button.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const markManual = () => { manualScrollRef.current = true; disableAutoFollow() }
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distance < 60) {
        userScrolledUpRef.current = false
        manualScrollRef.current = false
        setShowJumpToLatest(false)
      } else if (distance > 80) {
        userScrolledUpRef.current = true
        setShowJumpToLatest(true)
      }
    }
    el.addEventListener('wheel', markManual, { passive: true })
    el.addEventListener('touchstart', markManual, { passive: true })
    el.addEventListener('pointerdown', markManual, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', markManual)
      el.removeEventListener('touchstart', markManual)
      el.removeEventListener('pointerdown', markManual)
      el.removeEventListener('scroll', onScroll)
    }
  }, [aiWorking])

  // When AI stops, keep the user's reading position. The jump button should
  // remain available whenever the viewport is away from the bottom, not only
  // during streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 60) setShowJumpToLatest(false)
  }, [aiWorking])

  // New user turn: if the user sends while reading the middle of a long chat,
  // smoothly move to the freshly sent message, not blindly to the bottom.
  useEffect(() => {
    const prevLen = prevLenRef.current
    prevLenRef.current = messages.length
    const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id || ''
    const hasNewUserTurn = lastUserId && lastUserId !== prevLastUserIdRef.current
    prevLastUserIdRef.current = lastUserId

    if (messages.length > prevLen && hasNewUserTurn) {
      userScrolledUpRef.current = false
      manualScrollRef.current = false
      setShowJumpToLatest(false)
      scrollToMessage(lastUserId, 'smooth')
    } else if (messages.length > prevLen && !userScrolledUpRef.current) {
      scheduleScrollToBottom('auto')
    }
  }, [messages])

  // Auto-follow streamed content/tool growth only if the user has not taken
  // control. Use requestAnimationFrame + instant scroll to avoid stacking
  // smooth animations on every token.
  const lastMsg = messages[messages.length - 1]
  const lastToolCount = (lastMsg?.toolCalls?.length || 0) + (lastMsg?.thoughts?.length || 0)
  useEffect(() => {
    if (userScrolledUpRef.current) return
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance > 260) return
    scheduleScrollToBottom('auto')
  }, [lastToolCount, lastMsg?.content, lastMsg?.thinking])

  const armed = pullDistance >= threshold
  const displayedMessages = messages.length > visibleCount ? messages.slice(-visibleCount) : messages
  const hiddenCount = Math.max(0, messages.length - displayedMessages.length)

  const jumpToLatest = () => {
    const el = scrollRef.current
    userScrolledUpRef.current = false
    manualScrollRef.current = false
    setShowJumpToLatest(false)
    const scroll = (behavior = 'smooth') => {
      const root = scrollRef.current
      if (!root) return
      root.scrollTo({ top: root.scrollHeight + root.clientHeight, behavior })
    }
    if (el) {
      scroll('smooth')
      requestAnimationFrame(() => scroll('auto'))
      setTimeout(() => scroll('auto'), 180)
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }

  return (
    <div ref={scrollRef} role="log" aria-live={aiWorking ? 'polite' : 'off'} aria-relevant="additions text" className="mobile-scroll hide-scrollbar relative h-full min-h-0 overflow-y-auto" style={{ overscrollBehaviorY: 'contain', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}>
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

      <div className="mx-auto w-full max-w-2xl space-y-1">
        {hiddenCount > 0 && (
          <div className="flex justify-center px-4 py-2">
            <button
              type="button"
              onClick={() => setVisibleCount((n) => n + 80)}
              className="rounded-full border border-white/10 bg-graphite-800/70 px-3 py-1.5 text-[12px] text-cream-faint hover:bg-graphite-750 hover:text-cream"
            >
              Показать предыдущие {Math.min(80, hiddenCount)} из {hiddenCount}
            </button>
          </div>
        )}
        {displayedMessages.map((m, i) => (
          <MemoMessage
            key={m.id}
            m={m}
            chatId={chatId}
            isLast={hiddenCount + i === messages.length - 1}
            aiWorking={aiWorking}
            onEdit={onEdit}
            onRegenerate={onRegenerate}
            onResumeRun={onResumeRun}
            onOpenSettings={onOpenSettings}
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
          className="sticky bottom-24 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-full border border-white/15 bg-graphite-800/95 px-3 py-1.5 text-[12px] text-cream shadow-lg backdrop-blur hover:bg-graphite-700 md:bottom-3"
          style={{ marginLeft: 'auto', marginRight: 'auto', width: 'fit-content' }}
        >
          ↓ К последнему сообщению
        </button>
      )}
    </div>
  )
}
