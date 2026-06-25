/**
 * finalClaimValidator.js — Anti-hallucination check for final answers.
 *
 * Parses the model's final assistant text and cross-references its claims
 * against actual tool results. Returns a list of issues:
 *   - citedFileMissing: agent mentions a file path that was never read or written
 *   - claimedSuccessButFailed: agent says "successfully did X" but no tool succeeded
 *   - citedCommandButNoOutput: agent quotes command output that doesn't match reality
 *
 * Used in agentLoop.js right before sending the final 'done' event.
 */

import { basename } from 'node:path'

// Patterns that suggest an affirmative claim.
// ВНИМАНИЕ: \b в JS regex не работает с кириллицей даже с флагом u,
// поэтому используем кастомные границы слов через lookbehind/lookahead.
const CYR_BOUNDARY = String.raw`(?<=^|[^а-яёa-z\d])`
const CYR_BOUNDARY_END = String.raw`(?=$|[^а-яёa-z\d])`

const SUCCESS_CLAIM_RE = new RegExp(
  `${CYR_BOUNDARY}(?:успешно\\s+(?:склонировал|клонировал|выполнил|создал|сохранил|запустил|применил|установил|развернул|скоммитил|опубликовал|удалил|изменил|обновил)|(?:successfully|completed|done|ok)\\s+(?:clone|run|create|save|start|apply|install|deploy|commit|publish|delete|modify|update))${CYR_BOUNDARY_END}`,
  'iu'
)

// Patterns that suggest a positive action was performed.
const ACTION_VERB_RE = new RegExp(
  `${CYR_BOUNDARY}(?:создал|склонировал|задеплоил|закоммитил|сохранил|запустил|выполнил|применил|установил|опубликовал|развернул|обновил|удалил)${CYR_BOUNDARY_END}`,
  'iu'
)

// "Готово/выполнено/сделано" — отдельный паттерн с правильными границами
const DONE_CLAIM_RE = new RegExp(
  `${CYR_BOUNDARY}(?:готово|выполнено|сделано)${CYR_BOUNDARY_END}`,
  'iu'
)

// Extract file paths from text. Strict enough to catch real claims,
// lenient enough not to flag URLs or random numbers.
// Используем границы через whitespace/punct вместо \b чтобы кириллица тоже работала.
const PATH_RE = /(?:^|[\s'"`(,;])(?:\.{0,2}\/)?(?:[\w][\w./-]*\/)?[\w][\w.-]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|md|txt|sh|html|css|go|rs|java|rb|c|cpp|h|hpp|sql|env|cfg|ini|log|lock)(?=[\s'"`),.;:!?]|$)/gu

/**
 * @param {string} finalText - The model's final answer text
 * @param {object} ctx - { okReadPaths, failedReadPaths, touchedFiles, recentToolHistory, failedCommands }
 * @returns {{ issues: Array<{type, evidence, severity}>, verified: boolean }}
 */
export function validateFinalClaims(finalText = '', ctx = {}) {
  const issues = []
  const text = String(finalText || '')
  if (!text.trim()) return { issues, verified: true }

  const {
    okReadPaths = new Set(),
    failedReadPaths = new Set(),
    touchedFiles = new Set(),
    recentToolHistory = [],
    failedCommands = new Set(),
  } = ctx

  // 1) Check file path claims
  const citedPaths = new Set()
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0].trim().replace(/^['"`(]+|['"`),;]+$/g, '')
    if (p.length > 4 && !p.startsWith('http')) citedPaths.add(p)
  }
  for (const p of citedPaths) {
    const base = basename(p)
    const inOk = [...okReadPaths].some((op) => op === p || op.endsWith(p) || basename(op) === base)
    const inTouched = [...touchedFiles].some((tf) => tf === p || tf.endsWith(p) || basename(tf) === base)
    if (!inOk && !inTouched) {
      issues.push({
        type: 'citedFileMissing',
        severity: 'warn',
        evidence: `Финальный ответ упоминает файл "${p}", который не был прочитан или создан в этом запуске`,
      })
    }
  }

  // 2) Check "successfully did X" claims
  const hasSuccessClaim = SUCCESS_CLAIM_RE.test(text) || DONE_CLAIM_RE.test(text)
  if (hasSuccessClaim) {
    const TRIVIAL_TOOLS = new Set(['ask_user', 'recall_facts', 'plan_check', 'plan_set', 'list_files', 'read_file', 'search_files', 'recall_facts', 'kb_search', 'kb_list'])
    const anyRealSuccess = recentToolHistory.some((h) => {
      if (!h.ok) return false
      if (TRIVIAL_TOOLS.has(h.tool)) return false
      return true
    })
    if (!anyRealSuccess && recentToolHistory.length > 0) {
      issues.push({
        type: 'claimedSuccessButNoRealWork',
        severity: 'error',
        evidence: 'Финальный ответ утверждает об успехе, но ни один значимый tool не вернул ok=true',
      })
    }
  }

  // 3) Check claimed command outputs (only if text contains backticks with shell output)
  const commandOutputClaims = text.match(/`(?:[^`]*?(?:SHA|sha|commit|commit_[a-f0-9]+|cloned|fetched|✓|✗|error)[^`]*?)`/giu) || []
  for (const claim of commandOutputClaims) {
    if (/commit/i.test(claim)) {
      const hasCommitEvidence = recentToolHistory.some((h) => {
        if (!h.ok) return false
        if (h.tool === 'git_commit') return true
        const cmd = String(h.semantic?.command || '')
        return ['bash', 'shell', 'shell_session_run'].includes(h.tool) && /git\s+commit\b/i.test(cmd)
      })
      if (!hasCommitEvidence) {
        issues.push({
          type: 'claimedCommitButNoGitCommit',
          severity: 'error',
          evidence: `Финальный ответ упоминает git commit, но успешный git commit не подтверждён tool-историей`,
        })
      }
    }
  }

  // 4) Failed-but-claimed: agent claims success while tool clearly failed
  for (const h of recentToolHistory) {
    if (h.ok) continue
    if (!h.outcome) continue
    const outcomeSummary = String(h.outcome).slice(0, 80)
    // Если модель говорит "успешно" но был fail с тем же outcome — враньё
    // Сравниваем имя tool без подчёркиваний, чтобы git_clone matchил "git clone"
    const toolLoose = String(h.tool || '').toLowerCase().replace(/[_-]/g, '')
    const textLoose = text.toLowerCase().replace(/[_-]/g, '')
    const toolWords = String(h.tool || '').toLowerCase().split(/[_-]+/).filter((w) => w.length >= 4)
    const hasToolMention = text.toLowerCase().includes(h.tool.toLowerCase())
      || textLoose.includes(toolLoose)
      || toolWords.some((w) => text.toLowerCase().includes(w))
    if (text.toLowerCase().includes('успешно') && hasToolMention) {
      issues.push({
        type: 'claimedSuccessForFailedTool',
        severity: 'error',
        evidence: `Финальный ответ говорит "успешно" про ${h.tool}, но вызов вернул ok=false: ${outcomeSummary}`,
      })
    }
  }

  const verified = !issues.some((i) => i.severity === 'error')
  return { issues, verified }
}
