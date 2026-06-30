import { useState, useEffect, useMemo } from 'react'
import OperatorConsole from './OperatorConsole.jsx'
import OperatorMissionDetail from './OperatorMissionDetail.jsx'
import OperatorProjectsPanel from './OperatorProjectsPanel.jsx'
import OperatorRunbooks from './OperatorRunbooks.jsx'
import DeploySessionsPanel from './DeploySessionsPanel.jsx'
import AutomationCenter from './AutomationCenter.jsx'
import AutoRecoveryPanel from './AutoRecoveryPanel.jsx'
import FailureAdvisorPanel from './FailureAdvisorPanel.jsx'
import GitHubAutomationPanel from './GitHubAutomationPanel.jsx'
import AgentInbox from './AgentInbox.jsx'
import NotificationCenter from './NotificationCenter.jsx'
import AgentControlPlanePanel from './AgentControlPlanePanel.jsx'
import PolicyEditorPanel from './PolicyEditorPanel.jsx'
import MissionDependencyGraph from './MissionDependencyGraph.jsx'
import WipBanner from './WipBanner.jsx'
import WipGuard from './WipGuard.jsx'
import { useStubStatus } from '../lib/useStubStatus.js'

/**
 * OperatorPage — Package J: dedicated /operator/* routes.
 * Replaces the cramped tab inside /admin/agent with a proper operator console.
 *
 * Each tab declares its required API endpoints. The useStubStatus hook
 * checks which are still stubs/semi-stubs and shows honest "WIP" badges
 * instead of silently empty panels.
 */

const TABS = [
  { id: 'missions',    label: 'Миссии',       icon: '🎯', desc: 'Активные и завершённые миссии',
    endpoints: ['/api/operator/missions'] },
  { id: 'projects',   label: 'Проекты',       icon: '🗂️', desc: 'Репозитории и политики',
    endpoints: ['/api/operator/projects', '/api/operator/projects/analyze', '/api/operator/project-policy-presets', '/api/operator/project-templates'] },
  { id: 'incidents',  label: 'Инциденты',     icon: '🚨', desc: 'Инциденты и восстановление',
    endpoints: ['/api/operator/failure/classify', '/api/operator/failure/execute', '/api/operator/failure/incident', '/api/operator/recoveries', '/api/operator/recoveries/graph', '/api/operator/recoveries/supervise', '/api/incidents'] },
  { id: 'deploys',    label: 'Деплои',        icon: '🚀', desc: 'Deploy sessions',
    endpoints: ['/api/operator/deploy-sessions'] },
  { id: 'runbooks',   label: 'Runbooks',      icon: '📖', desc: 'Процедуры и уроки',
    endpoints: ['/api/operator/runbooks'] },
  { id: 'automation', label: 'Автоматизация', icon: '⚙️', desc: 'GitHub, расписания, recipes',
    endpoints: ['/api/operator/github-automation/events', '/api/operator/github-automation/comment', '/api/cron', '/api/agent/workflows'] },
  { id: 'policy',     label: 'Политики',      icon: '🛡️', desc: 'Права доступа и безопасность',
    endpoints: ['/api/agent/policy', '/api/approval/policy'] },
  { id: 'overview',   label: 'Обзор',         icon: '📊', desc: 'Дашборд и уведомления',
    endpoints: ['/api/agent/control-plane', '/api/notifications', '/api/agent/questions', '/api/agent/workflows', '/api/incidents'] },
]

export default function OperatorPage({ tab: initialTab = 'missions' }) {
  const [tab, setTab] = useState(() => {
    const valid = TABS.map(t => t.id)
    return valid.includes(initialTab) ? initialTab : 'missions'
  })

  const { isStub, isWip } = useStubStatus()

  // Sync URL without full reload
  useEffect(() => {
    const url = tab === 'missions' ? '/operator' : `/operator/${tab}`
    if (window.location.pathname !== url) {
      window.history.replaceState({}, '', url)
    }
  }, [tab])

  const current = TABS.find(t => t.id === tab) || TABS[0]

  // Compute WIP status per tab
  const tabStatus = useMemo(() => {
    const map = {}
    for (const t of TABS) {
      const endpoints = t.endpoints || []
      const allStub = endpoints.length > 0 && endpoints.every(p => isStub(p))
      const anyWip = endpoints.some(p => isWip(p))
      map[t.id] = allStub ? 'stub' : anyWip ? 'semi' : 'real'
    }
    return map
  }, [isStub, isWip])

  return (
    <div className="min-h-screen bg-graphite-900 text-cream">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/10 bg-graphite-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.location.href = '/'}
              className="text-cream-faint hover:text-cream transition-colors text-[13px]"
            >← Чат</button>
            <span className="text-cream-faint/40">|</span>
            <div>
              <h1 className="text-[15px] font-semibold">Operator Console</h1>
              <p className="text-[11px] text-cream-faint">{current.desc}</p>
            </div>
          </div>
          <a
            href="/admin/agent"
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-faint hover:bg-graphite-750 hover:text-cream transition-colors"
          >Dev Lab →</a>
        </div>

        {/* Tab nav — with WIP badges on stub tabs */}
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2">
          {TABS.map(t => {
            const status = tabStatus[t.id]
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`shrink-0 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition ${
                  tab === t.id
                    ? status === 'stub'
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-100'
                      : status === 'semi'
                        ? 'border-sky-500/40 bg-sky-500/15 text-sky-100'
                        : 'border-violet-400/40 bg-violet-500/20 text-violet-100'
                    : 'border-white/10 text-cream-faint hover:bg-white/5 hover:text-cream-soft'
                }`}
              >
                <span>{t.icon}</span>{t.label}
                {status === 'stub' && <span className="text-[9px] opacity-70">🚧</span>}
                {status === 'semi' && <span className="text-[9px] opacity-70">⚗️</span>}
              </button>
            )
          })}
        </nav>
      </header>

      {/* Content — wrapped with WipGuard where appropriate */}
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">
        {tab === 'overview' && (
          <>
            <WipGuard paths={['/api/agent/control-plane']} isWip={isWip} isStub={isStub}>
              <AgentControlPlanePanel />
            </WipGuard>
            <WipGuard paths={['/api/notifications']} isWip={isWip} isStub={isStub}>
              <NotificationCenter />
            </WipGuard>
            <WipGuard
              paths={['/api/agent/questions', '/api/incidents', '/api/agent/workflows', '/api/jobs']}
              isWip={isWip} isStub={isStub}
              title="Agent Inbox — частично в разработке"
              detail="Вопросы агента и задачи работают, но workflows и инциденты возвращают пустые данные."
            >
              <AgentInbox />
            </WipGuard>
          </>
        )}

        {tab === 'missions' && (
          <>
            <WipGuard paths={['/api/operator/missions']} isWip={isWip} isStub={isStub}>
              <OperatorConsole />
              <OperatorMissionDetail />
            </WipGuard>
            <WipGuard paths={['/api/operator/missions']} isWip={isWip} isStub={isStub}>
              <MissionDependencyGraph />
            </WipGuard>
          </>
        )}

        {tab === 'projects' && (
          <WipGuard
            paths={['/api/operator/projects', '/api/operator/projects/analyze', '/api/operator/project-policy-presets', '/api/operator/project-templates']}
            isWip={isWip} isStub={isStub}
            title="Проекты — частично в разработке"
            detail="Список проектов доступен, но анализ, шаблоны и пресеты политик ещё не реализованы."
          >
            <OperatorProjectsPanel />
          </WipGuard>
        )}

        {tab === 'incidents' && (
          <WipGuard
            paths={['/api/operator/failure/classify', '/api/operator/recoveries', '/api/incidents']}
            isWip={isWip} isStub={isStub}
            title="Инциденты и восстановление — в разработке"
            detail="Классификация сбоев, авто-recovery и граф зависимостей ещё не реализованы."
          >
            <>
              <FailureAdvisorPanel />
              <AutoRecoveryPanel />
            </>
          </WipGuard>
        )}

        {tab === 'deploys' && (
          <WipGuard
            paths={['/api/operator/deploy-sessions']}
            isWip={isWip} isStub={isStub}
            title="Deploy Sessions — в разработке"
            detail="Безопасные деплой-сессии с откатом ещё не реализованы на бэкенде."
          >
            <DeploySessionsPanel />
          </WipGuard>
        )}

        {tab === 'runbooks' && (
          <WipGuard
            paths={['/api/operator/runbooks']}
            isWip={isWip} isStub={isStub}
            title="Runbooks — в разработке"
          >
            <OperatorRunbooks />
          </WipGuard>
        )}

        {tab === 'automation' && (
          <WipGuard
            paths={['/api/operator/github-automation/events', '/api/cron', '/api/agent/workflows']}
            isWip={isWip} isStub={isStub}
            title="Автоматизация — в разработке"
            detail="GitHub-автоматизация, cron-расписания и workflows ещё не реализованы."
          >
            <>
              <GitHubAutomationPanel />
              <AutomationCenter />
            </>
          </WipGuard>
        )}

        {tab === 'policy' && (
          <WipGuard
            paths={['/api/agent/policy']}
            isWip={isWip} isStub={isStub}
            title="Политики агента — в разработке"
            detail="Политики доступа агента ещё не реализованы. Глобальные политики одобрения (approval policy) работают."
          >
            <PolicyEditorPanel />
          </WipGuard>
        )}
      </main>
    </div>
  )
}
