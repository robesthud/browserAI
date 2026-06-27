import { useState, useEffect } from 'react'
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

/**
 * OperatorPage — Package J: dedicated /operator/* routes.
 * Replaces the cramped tab inside /admin/agent with a proper operator console.
 */

const TABS = [
  { id: 'missions',    label: 'Миссии',       icon: '🎯', desc: 'Активные и завершённые миссии' },
  { id: 'projects',   label: 'Проекты',       icon: '🗂️', desc: 'Репозитории и политики' },
  { id: 'incidents',  label: 'Инциденты',     icon: '🚨', desc: 'Инциденты и восстановление' },
  { id: 'deploys',    label: 'Деплои',        icon: '🚀', desc: 'Deploy sessions' },
  { id: 'runbooks',   label: 'Runbooks',      icon: '📖', desc: 'Процедуры и уроки' },
  { id: 'automation', label: 'Автоматизация', icon: '⚙️', desc: 'GitHub, расписания, recipes' },
  { id: 'policy',     label: 'Политики',      icon: '🛡️', desc: 'Права доступа и безопасность' },
  { id: 'overview',   label: 'Обзор',         icon: '📊', desc: 'Дашборд и уведомления' },
]

export default function OperatorPage({ tab: initialTab = 'missions' }) {
  const [tab, setTab] = useState(() => {
    const valid = TABS.map(t => t.id)
    return valid.includes(initialTab) ? initialTab : 'missions'
  })

  // Sync URL without full reload
  useEffect(() => {
    const url = tab === 'missions' ? '/operator' : `/operator/${tab}`
    if (window.location.pathname !== url) {
      window.history.replaceState({}, '', url)
    }
  }, [tab])

  const current = TABS.find(t => t.id === tab) || TABS[0]

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

        {/* Tab nav */}
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`shrink-0 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition ${
                tab === t.id
                  ? 'border-violet-400/40 bg-violet-500/20 text-violet-100'
                  : 'border-white/10 text-cream-faint hover:bg-white/5 hover:text-cream-soft'
              }`}
            >
              <span>{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">
        {tab === 'overview' && (
          <>
            <AgentControlPlanePanel />
            <NotificationCenter />
            <AgentInbox />
          </>
        )}

        {tab === 'missions' && (
          <>
            <OperatorConsole />
            <OperatorMissionDetail />
            <MissionDependencyGraph />
          </>
        )}

        {tab === 'projects' && (
          <>
            <OperatorProjectsPanel />
          </>
        )}

        {tab === 'incidents' && (
          <>
            <FailureAdvisorPanel />
            <AutoRecoveryPanel />
          </>
        )}

        {tab === 'deploys' && <DeploySessionsPanel />}

        {tab === 'runbooks' && <OperatorRunbooks />}

        {tab === 'automation' && (
          <>
            <GitHubAutomationPanel />
            <AutomationCenter />
          </>
        )}

        {tab === 'policy' && <PolicyEditorPanel />}
      </main>
    </div>
  )
}
