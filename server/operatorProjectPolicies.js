const RISK_ORDER = { low: 1, medium: 2, high: 3, critical: 4 }

export const PROJECT_POLICY_PRESETS = {
  safe: {
    id: 'safe', label: 'Safe', description: 'Read/plan/code only. PR, merge and deploy require explicit manual steps.',
    allowed: { code: true, shell: true, createPr: false, waitCi: true, autoFixCi: false, merge: false, deploy: false, productionWrite: false },
    autonomy: { autoFinalize: false, autoWaitCi: true, autoFixCi: false, autoMerge: false, autoDeploy: false },
    requireApproval: { merge: true, deploy: true, productionWrite: true, highRiskReview: true },
  },
  balanced: {
    id: 'balanced', label: 'Balanced', description: 'Default: code, PR, CI and CI auto-fix allowed; merge/deploy require confirmation and green gates.',
    allowed: { code: true, shell: true, createPr: true, waitCi: true, autoFixCi: true, merge: true, deploy: true, productionWrite: true },
    autonomy: { autoFinalize: true, autoWaitCi: true, autoFixCi: true, autoMerge: false, autoDeploy: false },
    requireApproval: { merge: true, deploy: true, productionWrite: true, highRiskReview: true },
  },
  autonomous: {
    id: 'autonomous', label: 'Autonomous', description: 'For trusted non-critical projects: can finalize, wait CI, auto-fix and merge low-risk work.',
    allowed: { code: true, shell: true, createPr: true, waitCi: true, autoFixCi: true, merge: true, deploy: true, productionWrite: true },
    autonomy: { autoFinalize: true, autoWaitCi: true, autoFixCi: true, autoMerge: true, autoDeploy: false },
    requireApproval: { merge: false, deploy: true, productionWrite: true, highRiskReview: true },
  },
  production_critical: {
    id: 'production_critical', label: 'Production Critical', description: 'Strict production mode: review/CI required, high risk blocks merge/deploy, production writes always confirmed.',
    allowed: { code: true, shell: true, createPr: true, waitCi: true, autoFixCi: true, merge: true, deploy: true, productionWrite: true },
    autonomy: { autoFinalize: true, autoWaitCi: true, autoFixCi: true, autoMerge: false, autoDeploy: false },
    requireApproval: { merge: true, deploy: true, productionWrite: true, highRiskReview: true },
  },
}

const DEFAULT_LIMITS = { maxRuntimeMin: 60, maxCiFixAttempts: 2, maxChangedFiles: 80 }
const DEFAULT_PROTECTED_PATHS = ['.env', '.env.*', '**/.env', '**/*.pem', '**/*.key', '**/id_rsa', '**/id_ed25519', '**/credentials*', '**/secrets*']
const DEFAULT_HIGH_RISK_PATHS = ['deploy.sh', 'docker-compose.yml', 'Dockerfile', '.github/**', 'server/ops.js', 'server/index.js', '**/auth/**', '**/security/**', '**/policy/**']
const DEFAULT_RISK = { blockCritical: true, blockHighDeploy: true, blockSemanticHigh: true, requireCiForMerge: true, requireCiForDeploy: true }

function deepMerge(a = {}, b = {}) {
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k] || {}, v)
    else out[k] = v
  }
  return out
}

function bool(v, fallback = false) {
  return typeof v === 'boolean' ? v : fallback
}

export function normalizeProjectPolicy(input = {}) {
  const presetId = PROJECT_POLICY_PRESETS[input?.preset]?.id || PROJECT_POLICY_PRESETS[input?.id]?.id || 'balanced'
  const base = PROJECT_POLICY_PRESETS[presetId]
  const merged = deepMerge({
    schema: 'browserai.project_policy.v2',
    preset: presetId,
    allowed: {},
    autonomy: {},
    requireApproval: {},
    limits: DEFAULT_LIMITS,
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    highRiskPaths: DEFAULT_HIGH_RISK_PATHS,
    risk: DEFAULT_RISK,
  }, deepMerge(base, input || {}))
  return {
    schema: 'browserai.project_policy.v2',
    preset: presetId,
    label: merged.label || base.label,
    description: merged.description || base.description,
    allowed: {
      code: bool(merged.allowed?.code, base.allowed.code),
      shell: bool(merged.allowed?.shell, base.allowed.shell),
      createPr: bool(merged.allowed?.createPr, base.allowed.createPr),
      waitCi: bool(merged.allowed?.waitCi, base.allowed.waitCi),
      autoFixCi: bool(merged.allowed?.autoFixCi, base.allowed.autoFixCi),
      merge: bool(merged.allowed?.merge, base.allowed.merge),
      deploy: bool(merged.allowed?.deploy, base.allowed.deploy),
      productionWrite: bool(merged.allowed?.productionWrite, base.allowed.productionWrite),
    },
    autonomy: {
      autoFinalize: bool(merged.autonomy?.autoFinalize, base.autonomy.autoFinalize),
      autoWaitCi: bool(merged.autonomy?.autoWaitCi, base.autonomy.autoWaitCi),
      autoFixCi: bool(merged.autonomy?.autoFixCi, base.autonomy.autoFixCi),
      autoMerge: bool(merged.autonomy?.autoMerge, base.autonomy.autoMerge),
      autoDeploy: bool(merged.autonomy?.autoDeploy, base.autonomy.autoDeploy),
    },
    requireApproval: {
      merge: bool(merged.requireApproval?.merge, base.requireApproval.merge),
      deploy: bool(merged.requireApproval?.deploy, base.requireApproval.deploy),
      productionWrite: bool(merged.requireApproval?.productionWrite, base.requireApproval.productionWrite),
      highRiskReview: bool(merged.requireApproval?.highRiskReview, base.requireApproval.highRiskReview),
    },
    limits: {
      maxRuntimeMin: Math.max(5, Math.min(24 * 60, Number(merged.limits?.maxRuntimeMin) || DEFAULT_LIMITS.maxRuntimeMin)),
      maxCiFixAttempts: Math.max(0, Math.min(5, Number(merged.limits?.maxCiFixAttempts) || DEFAULT_LIMITS.maxCiFixAttempts)),
      maxChangedFiles: Math.max(1, Math.min(500, Number(merged.limits?.maxChangedFiles) || DEFAULT_LIMITS.maxChangedFiles)),
    },
    protectedPaths: Array.isArray(merged.protectedPaths) ? merged.protectedPaths.map(String).filter(Boolean).slice(0, 100) : DEFAULT_PROTECTED_PATHS,
    highRiskPaths: Array.isArray(merged.highRiskPaths) ? merged.highRiskPaths.map(String).filter(Boolean).slice(0, 100) : DEFAULT_HIGH_RISK_PATHS,
    risk: {
      blockCritical: bool(merged.risk?.blockCritical, true),
      blockHighDeploy: bool(merged.risk?.blockHighDeploy, true),
      blockSemanticHigh: bool(merged.risk?.blockSemanticHigh, true),
      requireCiForMerge: bool(merged.risk?.requireCiForMerge, true),
      requireCiForDeploy: bool(merged.risk?.requireCiForDeploy, true),
    },
  }
}

export function policyForProject(project = {}) {
  return normalizeProjectPolicy(project?.meta?.policy || project?.policy || {})
}

function globToRegex(pattern = '') {
  const escaped = String(pattern || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§DOUBLESTAR§§').replace(/\*/g, '[^/]*').replace(/§§DOUBLESTAR§§/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export function pathMatchesPolicyPattern(file = '', patterns = []) {
  const f = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
  return patterns.some((p) => {
    const pat = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!pat) return false
    if (f === pat || f.includes(pat.replace(/^\*\*\//, ''))) return true
    try { return globToRegex(pat).test(f) } catch { return false }
  })
}

function riskAtLeast(risk = 'low', min = 'high') {
  return (RISK_ORDER[String(risk || 'low')] || 1) >= (RISK_ORDER[String(min || 'high')] || 3)
}

export function evaluateProjectPolicy(policyInput = {}, action = '', context = {}) {
  const policy = normalizeProjectPolicy(policyInput)
  const warnings = []
  const blockers = []
  const files = Array.isArray(context.files) ? context.files : []
  const risk = String(context.risk || 'low')
  const confirmed = context.confirm === true || context.confirmMerge === true || context.confirmDeploy === true

  const deny = (message, code = 'POLICY_DENIED') => blockers.push({ code, message })
  const needApproval = (message, code = 'POLICY_APPROVAL_REQUIRED') => blockers.push({ code, message })

  if (['mission.code_task', 'mission.full_dev_cycle', 'code.start'].includes(action) && !policy.allowed.code) deny('Project policy disables code changes')
  if (['code.finalize'].includes(action) && !policy.allowed.createPr) deny('Project policy disables commit/push/PR finalization')
  if (['code.wait_ci'].includes(action) && !policy.allowed.waitCi) deny('Project policy disables CI waiting')
  if (['code.auto_fix_ci'].includes(action) && !policy.allowed.autoFixCi) deny('Project policy disables CI auto-fix')
  if (['code.merge'].includes(action) && !policy.allowed.merge) deny('Project policy disables PR merge')
  if (['code.deploy', 'mission.safe_deploy', 'mission.self_heal_restart'].includes(action) && !policy.allowed.deploy) deny('Project policy disables deploy/production actions')
  if (['code.deploy', 'mission.safe_deploy', 'mission.self_heal_restart'].includes(action) && !policy.allowed.productionWrite) deny('Project policy disables production writes')

  if (action === 'code.merge' && policy.requireApproval.merge && !confirmed) needApproval('Project policy requires confirmation before merge')
  if (action === 'code.deploy' && policy.requireApproval.deploy && !confirmed) needApproval('Project policy requires confirmation before deploy')
  if (['mission.safe_deploy', 'mission.self_heal_restart'].includes(action) && policy.requireApproval.productionWrite && !confirmed) needApproval('Project policy requires confirmation before production write')
  if (policy.requireApproval.highRiskReview && riskAtLeast(risk, 'high') && ['code.merge', 'code.deploy'].includes(action) && !confirmed) needApproval(`Project policy requires approval for ${risk}-risk ${action}`)

  if (policy.risk.blockCritical && risk === 'critical') deny('Project policy blocks critical-risk changes')
  if (policy.risk.blockHighDeploy && action === 'code.deploy' && riskAtLeast(risk, 'high')) deny('Project policy blocks high-risk deploy')
  if (policy.risk.requireCiForMerge && action === 'code.merge' && context.ciOk !== true) deny('Project policy requires green CI before merge')
  if (policy.risk.requireCiForDeploy && action === 'code.deploy' && context.ciOk !== true) deny('Project policy requires green CI before deploy')

  if (files.length > policy.limits.maxChangedFiles) deny(`Project policy changed-file limit exceeded: ${files.length}/${policy.limits.maxChangedFiles}`)
  const protectedHits = files.filter((f) => pathMatchesPolicyPattern(f, policy.protectedPaths))
  if (protectedHits.length) deny(`Protected paths changed: ${protectedHits.slice(0, 8).join(', ')}`)
  const highRiskHits = files.filter((f) => pathMatchesPolicyPattern(f, policy.highRiskPaths))
  if (highRiskHits.length) warnings.push(`High-risk paths touched: ${highRiskHits.slice(0, 8).join(', ')}`)

  return { ok: blockers.length === 0, action, policy, blockers, warnings }
}

export function applyPolicyToSuperOptions(options = {}, policyInput = {}) {
  const policy = normalizeProjectPolicy(policyInput)
  return {
    ...options,
    autoFinalize: Boolean(options.autoFinalize !== false && policy.allowed.createPr && policy.autonomy.autoFinalize),
    autoWaitCi: Boolean(options.autoWaitCi !== false && policy.allowed.waitCi && policy.autonomy.autoWaitCi),
    autoFixCi: Boolean(options.autoFixCi !== false && policy.allowed.autoFixCi && policy.autonomy.autoFixCi),
    maxCiFixAttempts: Math.min(Math.max(0, Number(options.maxCiFixAttempts || policy.limits.maxCiFixAttempts)), policy.limits.maxCiFixAttempts),
    autoMerge: Boolean(options.autoMerge === true && policy.allowed.merge && (policy.autonomy.autoMerge || options.confirmMerge === true)),
    autoDeploy: Boolean(options.autoDeploy === true && policy.allowed.deploy && policy.allowed.productionWrite && (policy.autonomy.autoDeploy || options.confirmDeploy === true)),
    policy,
  }
}

export default { PROJECT_POLICY_PRESETS, normalizeProjectPolicy, policyForProject, evaluateProjectPolicy, applyPolicyToSuperOptions, pathMatchesPolicyPattern }
