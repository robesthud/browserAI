/**
 * agentFinalComposer.js
 *
 * Evidence-backed final answer composer. The model can draft wording, but the
 * runtime owns the final report shape so BrowserAI does not claim work that is
 * not present in tool history and does not end with a useless "Готово".
 */

import {
  historyArgs,
  historyPath,
  obligationCompletionStatus,
  runtimeSemantics,
} from './agentRuntimeSemantics.js'

const NON_ACTION_TOOLS = new Set(['plan_set', 'plan_check', 'recall_facts', 'remember_fact', 'kb_search', 'kb_add'])

function uniquePush(arr, value, limit = 30) {
  const v = String(value || '').trim()
  if (!v) return
  if (!arr.includes(v)) arr.push(v)
  if (arr.length > limit) arr.splice(0, arr.length - limit)
}

export function collectRuntimeEvidence(agentContext = {}, recentToolHistory = []) {
  const real = (recentToolHistory || []).filter((h) => !NON_ACTION_TOOLS.has(String(h.tool || '')))
  const obligations = agentContext?.task?.obligations || {}
  const status = obligationCompletionStatus(obligations, recentToolHistory)
  const evidence = {
    real,
    status,
    obligations,
    changedFiles: [],
    readFiles: [],
    commands: [],
    checks: [],
    git: [],
    deploy: [],
    errors: [],
  }

  for (const h of real) {
    const semantic = runtimeSemantics(h)
    const args = semantic.args || historyArgs(h)
    const p = semantic.path || historyPath(h)
    if (h.ok && (semantic.isWrite || semantic.isEdit) && p) uniquePush(evidence.changedFiles, p)
    if (h.ok && semantic.family === 'shell') for (const changedPath of changedPathsFromOutcome(h.outcome || semantic.outcome || '')) uniquePush(evidence.changedFiles, changedPath)
    if (h.ok && semantic.isRead && p) uniquePush(evidence.readFiles, p)
    if (semantic.family === 'shell') uniquePush(evidence.commands, `${h.ok ? '✓' : '✗'} ${h.tool}: ${semantic.command || args.command || ''} → ${h.outcome || ''}`.slice(0, 500), 50)
    if (semantic.isVerify || /test|build|verify|exit=0|passed/i.test(String(h.outcome || ''))) uniquePush(evidence.checks, `${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || ''}`, 30)
    if (semantic.family === 'git' || /git\s+(status|diff|commit|push)/i.test(semantic.command || args.command || '')) uniquePush(evidence.git, `${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || semantic.command || args.command || ''}`, 30)
    if (semantic.family === 'ops' || semantic.family === 'docker' || semantic.isDeploy || semantic.isHealthCheck || semantic.isLogsCheck) uniquePush(evidence.deploy, `${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || semantic.command || args.command || ''}`, 30)
    if (!h.ok) uniquePush(evidence.errors, `✗ ${h.tool}: ${h.outcome || 'failed'}`, 30)
  }

  evidence.missing = Object.entries(obligations).filter(([k, v]) => v && k !== 'finalReport' && !status[k]).map(([k]) => k)
  return evidence
}

export function isWeakFinal(draft = '') {
  const text = String(draft || '').trim()
  if (!text) return true
  const hasEvidenceWords = /(измен[ёе]н|изменил|файл|команд|провер|тест|build|npm|git|deploy|деплой|curl|docker|ошиб|блокер|не удалось)/i.test(text)
  if (text.length < 80 && !hasEvidenceWords) return true
  return !hasEvidenceWords
}

function changedPathsFromOutcome(outcome = '') {
  const s = String(outcome || '')
  const m = s.match(/\bpaths=([^\n]+)/i)
  if (!m) return []
  return m[1].split(',').map((p) => p.trim()).filter(Boolean).slice(0, 30)
}

function shortCommandLine(line = '') {
  return String(line || '').replace(/\s+/g, ' ').slice(0, 180)
}

export function composeEvidenceSummary({ agentContext = {}, recentToolHistory = [], finalStatus = null } = {}) {
  const e = collectRuntimeEvidence(agentContext, recentToolHistory)
  const lines = []

  if (e.changedFiles.length) {
    lines.push('**Файлы:**')
    for (const f of e.changedFiles.slice(0, 12)) lines.push(`- изменён: ${f}`)
  } else if (e.readFiles.length) {
    lines.push('**Файлы:**')
    for (const f of e.readFiles.slice(0, 8)) lines.push(`- прочитан: ${f}`)
  }

  if (e.commands.length) {
    lines.push('**Команды:**')
    for (const c of e.commands.slice(-8)) lines.push(`- ${shortCommandLine(c)}`)
  }

  if (e.checks.length) {
    lines.push('**Проверка:**')
    for (const c of e.checks.slice(-6)) lines.push(`- ${shortCommandLine(c)}`)
  } else if (finalStatus?.localTests?.attempted === false || e.missing.includes('verify')) {
    lines.push('**Проверка:**')
    lines.push('- нет подтверждённой успешной проверки после последнего изменения')
  }

  if (e.git.length) {
    lines.push('**Git:**')
    for (const c of e.git.slice(-6)) lines.push(`- ${shortCommandLine(c)}`)
  }

  if (e.deploy.length) {
    lines.push('**Deploy/ops:**')
    for (const c of e.deploy.slice(-8)) lines.push(`- ${shortCommandLine(c)}`)
  }

  if (e.errors.length) {
    lines.push('**Ошибки/ограничения:**')
    for (const c of e.errors.slice(-6)) lines.push(`- ${shortCommandLine(c)}`)
  }

  if (finalStatus?.blockers?.length) {
    lines.push('**Замечания:**')
    for (const b of finalStatus.blockers.slice(0, 6)) lines.push(`- ${b.reason || b.type || 'есть незакрытый пункт'}`)
  }

  return lines.join('\n')
}

export function buildRuntimeEvidenceReport(agentContext = {}, recentToolHistory = [], agentState = {}) {
  const e = collectRuntimeEvidence(agentContext, recentToolHistory)
  if (!e.real.length) return ''

  const lines = ['\n\n---', '### Runtime evidence']
  if (e.changedFiles.length) lines.push('**Изменённые файлы:**', ...e.changedFiles.slice(0, 20).map((f) => `- ${f}`))
  if (!e.changedFiles.length && e.readFiles.length) lines.push('**Прочитанные файлы:**', ...e.readFiles.slice(0, 10).map((f) => `- ${f}`))
  if (e.commands.length) lines.push('**Команды:**', ...e.commands.slice(-12).map((c) => `- ${c}`))
  if (e.checks.length) lines.push('**Проверки:**', ...e.checks.slice(-8).map((c) => `- ${c}`))
  if (e.git.length) lines.push('**Git:**', ...e.git.slice(-8).map((c) => `- ${c}`))
  if (e.deploy.length) lines.push('**Deploy/ops/health/logs:**', ...e.deploy.slice(-10).map((c) => `- ${c}`))
  if (e.errors.length) lines.push('**Ошибки/восстановление:**', ...e.errors.slice(-8).map((err) => `- ${err}`))
  if (Object.keys(e.obligations).some((k) => e.obligations[k])) {
    lines.push('**Статус обязательств:**')
    for (const [k, v] of Object.entries(e.obligations)) if (v && k !== 'finalReport') lines.push(`- ${e.status[k] ? '✓' : '⚠'} ${k}`)
  }
  if (e.missing.length) lines.push(`**Незакрытые обязательства:** ${e.missing.join(', ')} — см. замечания/ограничения выше.`)
  agentState.obligationStatus = e.status
  return lines.join('\n')
}

export function appendRuntimeEvidence(text = '', agentContext = {}, recentToolHistory = [], agentState = {}) {
  const report = buildRuntimeEvidenceReport(agentContext, recentToolHistory, agentState)
  if (!report) return String(text || '')
  const base = String(text || '').trim()
  if (/### Runtime evidence|Runtime evidence/i.test(base)) return base
  return `${base}${report}`.trim()
}

export function composeEvidenceBackedFinal({ draft = '', agentContext = {}, recentToolHistory = [], agentState = {}, finalStatus = null } = {}) {
  const baseDraft = String(draft || '').trim()
  const hasRealWork = collectRuntimeEvidence(agentContext, recentToolHistory).real.length > 0
  if (!hasRealWork) return baseDraft

  let base = baseDraft
  if (isWeakFinal(baseDraft)) {
    const summary = composeEvidenceSummary({ agentContext, recentToolHistory, finalStatus })
    base = ['Готово. Ниже — что подтверждено реальными действиями агента.', summary].filter(Boolean).join('\n\n').trim()
  }

  return appendRuntimeEvidence(base, agentContext, recentToolHistory, agentState)
}

export const __test = {
  NON_ACTION_TOOLS,
  uniquePush,
  shortCommandLine,
}
