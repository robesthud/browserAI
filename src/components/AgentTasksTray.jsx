import { useEffect, useState } from 'react'
import { listAgentTasks, listActiveAgentRuns, resetAgentRun } from '../lib/agentTasks.js'

function statusColor(status) {
  if (status === 'succeeded') return 'text-emerald-300'
  if (status === 'failed') return 'text-rose-300'
  if (status === 'cancelled') return 'text-cream-faint'
  return 'text-amber-300'
}

function statusIcon(status) {
  return { succeeded: '✓', failed: '✗', cancelled: '⊘', running: '⏳' }[status] || '•'
}

function progress(task) {
  const steps = task?.state?.plan?.steps || []
  if (!steps.length) return ''
  const done = steps.filter((s) => s.done || (task?.state?.plan?.done || []).includes(s.idx)).length
  return `${done}/${steps.length}`
}

export default function AgentTasksTray({ chatId = '', onResume, onFlash }) {
  const [tasks, setTasks] = useState([])
  const [runs, setRuns] = useState([])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const [taskData, runData] = await Promise.all([
          chatId ? listAgentTasks(chatId, 5).catch(() => ({ tasks: [] })) : Promise.resolve({ tasks: [] }),
          listActiveAgentRuns().catch(() => ({ runs: [] })),
        ])
        if (cancelled) return
        setTasks((taskData.tasks || []).slice(0, 3))
        setRuns(runData.runs || [])
      } catch { /* ignore */ }
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [chatId])

  const activeRun = runs.find((r) => r.chatId === chatId)
  if (!chatId || (!tasks.length && !activeRun)) return null

  const resetRun = async () => {
    try {
      await resetAgentRun(chatId)
      setRuns((prev) => prev.filter((r) => r.chatId !== chatId))
      onFlash?.({ kind: 'info', text: 'Зависший запуск агента сброшен.' })
    } catch (e) {
      onFlash?.({ kind: 'error', text: e.message || 'Не удалось сбросить запуск' })
    }
  }

  return (
    <div className="my-2 rounded-lg border border-white/10 bg-graphite-900/40 p-2 text-[12px]">
      <div className="mb-1 flex items-center justify-between px-1 text-[11px] uppercase tracking-wide text-cream-faint">
        <span>Agent tasks</span>
        {activeRun && <button onClick={resetRun} className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] normal-case text-rose-200 hover:bg-rose-500/25">reset</button>}
      </div>
      <div className="space-y-1">
        {activeRun && (
          <div className="rounded border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-amber-100">
            Активен {Math.round((activeRun.ageMs || 0) / 1000)}с
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="rounded bg-black/15 px-2 py-1.5 text-cream-soft">
            <div className="flex items-center gap-1.5">
              <span className={statusColor(t.status)}>{statusIcon(t.status)}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-cream" title={t.goal}>{t.goal || t.taskType || 'agent task'}</span>
              {progress(t) && <span className="font-mono text-[10px] text-cream-faint">{progress(t)}</span>}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-cream-faint">
              <span className="truncate">{t.phase || t.state?.phase || '—'}</span>
              {['running', 'failed'].includes(t.status) && (
                <button
                  onClick={() => onResume?.(t)}
                  className="ml-auto rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-200 hover:bg-violet-500/25"
                >
                  продолжить
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
