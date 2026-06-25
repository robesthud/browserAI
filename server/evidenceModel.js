/**
 * Typed evidence model for task-specific evidence tracking.
 * Maps task types to expected evidence categories and validates
 * that the final answer is grounded in real tool output.
 */

export const EVIDENCE_CATEGORIES = {
  inspect: {
    required: ['list_files', 'read_file', 'search_files', 'bash'],
    semanticMatch: (h) => h.semantic?.isInspect || h.semantic?.isRead || h.semantic?.isSearch,
    description: 'Files/directories were inspected before making claims',
  },
  codeChange: {
    required: ['write_file', 'edit_file', 'bash'],
    semanticMatch: (h) => h.semantic?.isWrite || h.semantic?.isEdit,
    description: 'Code/config files were actually created or modified',
  },
  test: {
    required: ['npm_test', 'verify_task', 'verify_code', 'bash'],
    semanticMatch: (h) => h.semantic?.isLocalTest || h.semantic?.isVerify,
    description: 'Tests or verification commands were executed',
  },
  deploy: {
    required: ['ops_run_action', 'bash', 'git_commit'],
    semanticMatch: (h) => h.semantic?.isDeploy || h.semantic?.isCommit || h.semantic?.isPush,
    description: 'Deploy actions were executed and followed by health/log check',
  },
  blocker: {
    required: [],
    semanticMatch: (h) => !h.ok,
    description: 'Tool failures that explain why something could not be completed',
  },
}

export function categorizeEvidence(toolHistory = []) {
  const categories = {
    inspect: [],
    codeChange: [],
    test: [],
    deploy: [],
    blocker: [],
  }
  for (const h of toolHistory) {
    for (const [cat, def] of Object.entries(EVIDENCE_CATEGORIES)) {
      if (def.semanticMatch(h)) {
        categories[cat].push({
          tool: h.tool,
          ok: h.ok,
          at: h.at,
          path: h.semantic?.path || h.semantic?.command || null,
          outcome: h.outcome,
        })
      }
    }
  }
  return categories
}

export function evidenceGapForTaskType(taskType = '', categories = {}) {
  const gaps = []
  const c = { inspect: [], codeChange: [], test: [], deploy: [], blocker: [], ...categories }
  if (taskType.includes('repo_analysis') && c.inspect.length === 0) {
    gaps.push({ type: 'missing_inspect', message: 'Repo analysis requires inspect evidence (list_files/read_file/search_files).' })
  }
  if ((taskType.includes('code') || taskType.includes('project') || taskType.includes('fix')) && c.codeChange.length === 0) {
    gaps.push({ type: 'missing_code_change', message: 'Code task requires write_file/edit_file evidence.' })
  }
  if (taskType.includes('test') && c.test.length === 0) {
    gaps.push({ type: 'missing_test', message: 'Test task requires npm_test/verify_task/bash test evidence.' })
  }
  if (taskType.includes('deploy') && c.deploy.length === 0) {
    gaps.push({ type: 'missing_deploy', message: 'Deploy task requires deploy/ops/git_commit evidence.' })
  }
  return gaps
}

export function validateClaimsAgainstEvidence({ text = '', categories = {}, toolHistory = [], failedReadPaths = new Set(), okReadPaths = new Set() } = {}) {
  const violations = []

  // Claim: "all tests passed" / "все тесты пройдены" without test evidence
  const testPassedClaim = /(all tests passed|tests?\s+passed|passed:\s*\d+\/\d+|все тесты пройдены|все проверки пройдены|smoke[- ]test.*passed|тест:\s*pass)/i.test(text)
  if (testPassedClaim && categories.test.filter((t) => t.ok).length === 0) {
    violations.push({ type: 'unsupported_test_claim', message: 'Claimed tests passed but no successful test evidence exists.' })
  }

  // Claim: "file X changed/created" without write/edit evidence
  const fileChangedClaim = /(файл\s+\S+\s+(изменён|создан|обновлён|записан)|\bfile\s+\S+.*\b(changed|created|updated|written|modified))/i.test(text)
  if (fileChangedClaim && categories.codeChange.filter((c) => c.ok).length === 0) {
    violations.push({ type: 'unsupported_file_claim', message: 'Claimed file changes but no write/edit evidence exists.' })
  }

  // Claim: "project is ready / готов" without code + verify
  const readyClaim = /(проект\s+готов|project\s+is\s+ready|ready\s+for\s+production)/i.test(text)
  if (readyClaim && (categories.codeChange.filter((c) => c.ok).length === 0 || categories.test.filter((t) => t.ok).length === 0)) {
    violations.push({ type: 'unsupported_ready_claim', message: 'Claimed project ready but missing code change or test evidence.' })
  }

  // Claim cites failed reads (fabrication)
  if (failedReadPaths.size > 0) {
    for (const p of failedReadPaths) {
      const base = p.split('/').pop()
      if (base && base.length > 3 && text.includes(base) && !okReadPaths.has(p)) {
        violations.push({ type: 'fabrication', message: `Text references file ${base} that was never successfully read.`, path: p })
      }
    }
  }

  return violations
}

export function evidenceModelToText(categories = {}) {
  const lines = []
  for (const [cat, entries] of Object.entries(categories)) {
    if (entries.length === 0) continue
    const ok = entries.filter((e) => e.ok).length
    const fail = entries.filter((e) => !e.ok).length
    lines.push(`- ${cat}: ${entries.length} events (${ok} ok, ${fail} failed)`)
  }
  if (lines.length === 0) return 'No evidence recorded.'
  return lines.join('\n')
}

export default { categorizeEvidence, evidenceGapForTaskType, validateClaimsAgainstEvidence, evidenceModelToText, EVIDENCE_CATEGORIES }
