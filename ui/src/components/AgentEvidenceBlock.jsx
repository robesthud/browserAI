import { useMemo, useState } from 'react'
import { classifyEvidenceStatus, summarizeEvidence } from '../lib/evidenceStatus.js'

const LABELS = {
  success: 'Выполнено',
  partial: 'Частично',
  blocked: 'Есть замечания',
  interrupted: 'Прервано',
  unknown: 'Статус',
}

const BLOCKER_LABELS = {
  missing_test: 'Проверка не запущена',
  test_failed: 'Проверка завершилась с ошибкой',
  missing_verification: 'Нет подтверждённой проверки',
  unmet_obligation: 'Не выполнен обязательный шаг',
  max_steps: 'Достигнут лимит шагов',
  deadline: 'Истекло время выполнения',
  aborted: 'Остановлено пользователем',
  runtime_error: 'Ошибка выполнения',
  fabrication: 'Самопроверка нашла расхождение',
}

function humanReason(reason = '') {
  const raw = String(reason || '')
  if (!raw) return ''
  const push = raw.match(/obligation\s+"push"\s+is required/i)
  if (push) return 'Агент ожидал push в Git, но задача не была отправлена в репозиторий. Если push не требовался — это можно игнорировать.'
  return raw
    .replace(/Obligation\s+"(.+?)"\s+is required but not satisfied in tool history\./i, 'Обязательный шаг «$1» не подтверждён в выполненных действиях.')
    .replace(/Agent reached step limit/i, 'Агент дошёл до лимита шагов')
}

export default function AgentEvidenceBlock({ finalStatus, collapsed = true, summary = null }) {
  const fs = useMemo(() => finalStatus || {}, [finalStatus])
  const status = useMemo(() => classifyEvidenceStatus(fs), [fs])
  const [open, setOpen] = useState(!collapsed ? status.tone === 'unknown' : false)
  const ss = useMemo(() => summarizeEvidence(fs, summary), [fs, summary])
  const label = LABELS[status.tone] || status.label || 'Статус'
  const blockers = Array.isArray(fs.blockers) ? fs.blockers : []

  return (
    <div className={`agent-evidence-block tone-${status.tone}`}>
      <button
        type="button"
        className="agent-evidence-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`agent-evidence-pill tone-${status.tone}`}>{status.glyph} {label}</span>
        <span className="agent-evidence-summary">
          {ss.filesChanged != null && ss.filesChanged > 0 && <span>{ss.filesChanged} файл(ов)</span>}
          {ss.commandsRun != null && ss.commandsRun > 0 && <span>{ss.commandsRun} команд</span>}
          {ss.testsRun != null && ss.testsRun > 0 && <span>{ss.testsPassed}/{ss.testsRun} проверок</span>}
          {blockers.length > 0 && <span>{blockers.length} замеч.</span>}
        </span>
        <span className="agent-evidence-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="agent-evidence-body">
          <EvidenceRow label="Файлы" value={`прочитано ${ss.filesRead || 0} · изменено ${ss.filesChanged || 0}`} />
          <EvidenceRow label="Команды" value={ss.commandsRun || 0} />
          <EvidenceRow
            label="Проверки"
            value={fs.localTests
              ? `${fs.localTests.attempted ? 'запускались' : 'не запускались'} · ${fs.localTests.passed ? 'прошли' : 'нет успешной проверки'} (${ss.testsPassed || 0}/${ss.testsRun || 0})`
              : '—'}
          />
          <EvidenceRow
            label="Деплой"
            value={fs.deploy
              ? `${fs.deploy.requested ? 'запрошен' : 'не запрошен'} · ${fs.deploy.done ? 'выполнен' : 'не выполнялся'} · ${fs.deploy.verified ? 'проверен' : 'без проверки'}`
              : '—'}
          />

          {blockers.length > 0 && (
            <div className="agent-evidence-blockers">
              <div className="agent-evidence-blockers-title">Замечания</div>
              <ul>
                {blockers.map((b, i) => (
                  <li key={i} className={`blocker tone-${b.type}`}>
                    <span className="blocker-type">{BLOCKER_LABELS[b.type] || b.type}</span>
                    {b.reason && <span> — {humanReason(b.reason)}</span>}
                    {b.evidence && <span className="blocker-evidence"> · {b.evidence}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EvidenceRow({ label, value }) {
  return (
    <div className="agent-evidence-row">
      <span className="agent-evidence-row-label">{label}</span>
      <span className="agent-evidence-row-value">{value}</span>
    </div>
  )
}
