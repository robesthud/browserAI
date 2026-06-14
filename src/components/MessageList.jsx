import { memo, useEffect, useRef, useState } from 'react'
import { IconBot, IconUser, IconFile, IconCopy, IconEdit, IconRefresh, IconCheck } from '../icons.jsx'
import { formatSize } from '../lib/files.js'
import Markdown from '../lib/markdown.jsx'
import AgentToolBlock from './AgentToolBlock.jsx'
import AgentRuntimePanel from './AgentRuntimePanel.jsx'
import AgentThought from './AgentThought.jsx'
import AgentPlanCard from './AgentPlanCard.jsx'
import AgentExtendedThinking from './AgentExtendedThinking.jsx'
import AgentAskUser from './AgentAskUser.jsx'
import JobCard from './JobCard.jsx'
// import usePullToRefresh from '../lib/usePullToRefresh.js'
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
  if (/400|bad request/.test(lower)) return 'Провайдер отклонил запрос (HTTP 400). Эта модель может не поддерживать вызов инструментов. Попробуй Claude, GPT-4, Gemini или DeepSeek.'
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

function compactToolPreview(tool = null) {
  if (!tool) return null
  const name = String(tool.name || '')
  const args = tool.args || {}
  const isCommand = ['bash', 'shell_session_run', 'shell_background_start', 'shell_background_read'].includes(name)
  const command = args.command || args.task_id || args.taskId || args.path || ''
  const result = tool.result || {}
  let output = tool.stream || result.stdout || result.stderr || tool.error || ''
  if (typeof output !== 'string') {
    try { output = JSON.stringify(output) } catch { output = String(output || '') }
  }
  output = output.split('\n').filter(Boolean).slice(-3).join(' · ')
  return {
    label: isCommand ? (name === 'bash' ? 'bash' : name.replace(/^shell_/, 'shell ')) : name,
    command: String(command || '').replace(/\s+/g, ' ').slice(0, 180),
    output: String(output || '').replace(/\s+/g, ' ').slice(0, 220),
    running: tool.status !== 'done',
    ok: tool.ok !== false,
  }
}

function AgentActivityFold({ message, children }) {
  const tools = (message.toolCalls || []).filter((tc) => tc.name !== 'plan_set' && tc.name !== 'plan_check')
  const thoughts = message.thoughts || []
  const activeTool = [...tools].reverse().find((tc) => tc.status !== 'done')
  const lastTool = activeTool || tools[tools.length - 1]
  const lastThought = thoughts[thoughts.length - 1]?.text || ''
  const failed = tools.filter((tc) => tc.status === 'done' && tc.ok === false).length
  const done = tools.filter((tc) => tc.status === 'done' && tc.ok !== false).length
  const statusText = activeTool
    ? `выполняю ${activeTool.name}`
    : failed
      ? `есть ошибки: ${failed}`
      : tools.length
        ? `выполнено действий: ${done}/${tools.length}`
        : 'планирую'
  const hint = activeTool?.args?.command || activeTool?.args?.path || lastTool?.args?.command || lastTool?.args?.path || lastThought
  const preview = compactToolPreview(activeTool || lastTool)
  return (
    <details className="mb-2 rounded-xl border border-white/10 bg-graphite-800/35 text-[13px]" open={false}>
      <summary className="cursor-pointer list-none px-3 py-2 text-cream-soft hover:bg-white/5">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full align-middle ${activeTool ? 'animate-pulse bg-amber-300' : failed ? 'bg-red-300' : 'bg-emerald-300'}`} />
          <span className="font-medium">Ход работы агента</span>
          <span className="text-cream-faint">{statusText}</span>
          {hint ? <span className="hidden min-w-0 max-w-[360px] truncate align-bottom text-cream-faint/70 md:inline-block">{String(hint).replace(/\s+/g, ' ').slice(0, 160)}</span> : null}
          <span className="ml-auto shrink-0 text-cream-faint">раскрыть</span>
        </div>
        {preview && (preview.command || preview.output) ? (
          <div className="mt-1.5 rounded-lg border border-white/5 bg-black/15 px-2 py-1 font-mono text-[11px] leading-relaxed text-cream-faint">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={preview.running ? 'text-amber-300' : preview.ok ? 'text-emerald-300' : 'text-red-300'}>{preview.running ? '●' : preview.ok ? '✓' : '✗'}</span>
              <span className="shrink-0 text-cream-soft">{preview.label}</span>
              {preview.command ? <span className="min-w-0 truncate">{preview.command}</span> : null}
            </div>
            {preview.output ? <div className="mt-0.5 truncate text-cream-faint/80">{preview.output}{preview.running ? ' ▌' : ''}</div> : null}
          </div>
        ) : null}
      </summary>
      <div className="space-y-1 border-t border-white/5 px-2.5 py-2">
        {children}
      </div>
    </details>
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
  const showsThinkingPill = !isUser && Boolean(m.thinking && !isDev && m.pending)

  // Mobile swipe-left -> reveal action buttons (regenerate / copy).
  // The hook is a no-op on desktop because there are no touch events.
  const swipe = useSwipeActions()

  const copyMessage = async () => {
    try { await navigator.clipboard.writeText(m.content || '') } catch { /* clipboard unavailable */ }
    swipe.reset()
  }

  return (
    <div className="group relative overflow-hidden" data-message-id={m.id} data-role={m.role}>
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
          {!isUser && isDev && hasAgentActivity && (
            <button
              onClick={() => {
                const trace = {
                  schema: 'browserai.agent_trace.v1',
                  id: m.id,
                  role: 'assistant',
                  content: m.content,
                  agentContext: m.agentContext,
                  agentState: m.agentState,
                  tools: m.toolCalls,
                  thoughts: m.thoughts,
                  askUsers: m.askUsers,
                  error: m.error,
                  providerError: m.providerError,
                  warnings: m.routerWarnings,
                  tokens: m.tokens
                }
                const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `agent-trace-${m.id}.json`
                a.click()
                URL.revokeObjectURL(url)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-cream-faint hover:text-cream px-1"
              title="Export Agent Trace JSON"
            >
              {"{}"}
            </button>
          )}
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
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-cream-soft" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
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
          <div className="text-[14px] leading-relaxed text-cream-soft" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
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

                  // 1:1 Arena Parity: AgentRuntimePanel (debug state) is ONLY for devtools.
                  if (isDev && m.agentState) {
                    items.push(<AgentRuntimePanel key={`runtime-${m.id}`} context={m.agentContext} state={m.agentState} aiWorking={aiWorking} isDev={isDev} />)
                  }

                  // 1:1 Arena Parity: Tool cards and Plan are ALWAYS visible during/after execution.
                  // No "Show more" buttons or extra technical toggles.
                  
                  // Plan logic
                  let plan = m.agentState?.plan
                  if (!plan) {
                    // Legacy fallback for old chats
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
                  }
                  if (plan && plan.steps?.length > 0) {
                    items.push(<AgentPlanCard key="plan" plan={plan} />)
                  }

                  for (const tc of m.toolCalls || []) {
                    const ths = thoughtsByStep.get(tc.step) || []
                    // Thoughts are shown only if they contain text (narrative)
                    for (const t of ths) {
                      items.push(<AgentThought key={`th-${tc.step}-${t.at}`} text={t.text} />)
                    }
                    thoughtsByStep.delete(tc.step)

                    // Hide plan tools — they are rendered as the AgentPlanCard above.
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
                        onRetry={(tool) => {
                          window.dispatchEvent(new CustomEvent('agent:retry-tool', { 
                            detail: { name: tool.name, args: tool.args } 
                          }))
                        }}
                      />,
                    )
                  }
                  if (!isDev && items.length > 0) {
                    return <AgentActivityFold key={`fold-${m.id}`} message={m}>{items}</AgentActivityFold>
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

            {m.content ? (() => {
              const parts = !isDev ? splitRuntimeEvidence(m.content) : { main: m.content, evidence: '' }
              return (
                <div className={hasAgentActivity ? 'mt-3 border-t border-white/10 pt-3' : ''}>
                  <Markdown text={parts.main || m.content} />
                  {parts.evidence ? (
                    <details className="mt-3 rounded-xl border border-white/10 bg-graphite-800/35 text-[13px]">
                      <summary className="cursor-pointer px-3 py-2 text-cream-soft hover:bg-white/5">Технический отчёт и evidence</summary>
                      <div className="border-t border-white/5 px-3 py-2 text-cream-soft">
                        <Markdown text={parts.evidence} />
                      </div>
                    </details>
                  ) : null}
                </div>
              )
            })() : null}

            {m.pending && !m.content && !showsThinkingPill && !(m.job && ['succeeded', 'failed', 'cancelled'].includes(m.job.status)) && (
              <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-graphite-800/60 px-2.5 py-1 text-[12px] text-cream-faint">
                <span className={`inline-block h-2 w-2 animate-pulse rounded-full ${m.agentState?.status === 'thinking' || (!m.agentState && !hasAgentActivity) ? 'bg-amber-300' : 'bg-emerald-300'}`} />
                <span>{m.agentState?.status === 'thinking' || (!m.agentState && !hasAgentActivity) ? 'Агент размышляет…' : 'Агент выполняет действия…'}</span>
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

export default function MessageList({ messages, aiWorking, onEdit, onRegenerate, onAnswerAskUser, onCancelAskUser, onJobDone, onBranch }) {
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
      if (aiWorking) setShowJumpToLatest(true)
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
      } else if (manualScrollRef.current && distance > 80) {
        userScrolledUpRef.current = true
        if (aiWorking) setShowJumpToLatest(true)
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

  // When AI is no longer working, keep the user's reading position, but hide
  // the jump button. If they are already at the bottom, auto-follow is ready
  // for the next turn.
  useEffect(() => {
    if (!aiWorking) setShowJumpToLatest(false)
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

  const jumpToLatest = () => {
    userScrolledUpRef.current = false
    setShowJumpToLatest(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div ref={scrollRef} className="hide-scrollbar relative flex-1 overflow-y-auto">
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
          <MemoMessage
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
