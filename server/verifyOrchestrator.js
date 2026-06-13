function uniq(arr) { return [...new Set((arr || []).filter(Boolean))] }
function isJs(path = '') { return /\.(js|mjs|cjs)$/i.test(path) }
function isJson(path = '') { return /\.json$/i.test(path) }
function isCode(path = '') { return /\.(js|mjs|cjs|jsx|ts|tsx|json|css|html|ya?ml)$/i.test(path) }
function under(path = '', prefix = '') { return prefix && (path === prefix || path.startsWith(prefix + '/')) }

export function buildVerificationPlan({ profile = {}, touchedFiles = [], taskType = '' } = {}) {
  const files = uniq(touchedFiles.map((f) => String(f || '').replace(/^\/+/, '')))
  const root = String(profile.root || '').replace(/^\/+|\/+$/g, '')
  const relToRoot = (f) => root && f.startsWith(root + '/') ? f.slice(root.length + 1) : f
  const actions = []

  for (const file of files) {
    if (isJs(file) || isJson(file)) actions.push({ kind: 'tool', tool: 'verify_code', args: { path: file }, reason: 'syntax-check touched JS/JSON' })
  }

  const scripts = profile.scripts || {}
  const hasSrcChange = files.some((f) => /(^|\/)src\//.test(relToRoot(f)) || /\.(jsx|tsx|css|html)$/.test(f))
  const hasServerChange = files.some((f) => /(^|\/)server\//.test(relToRoot(f)) || /\.(js|mjs|cjs)$/.test(f))
  const hasPackageChange = files.some((f) => /(^|\/)package(-lock)?\.json$/.test(relToRoot(f)))
  const hasDockerChange = files.some((f) => /(Dockerfile|docker-compose\.ya?ml)$/.test(f))

  const run = (command, reason, timeoutSec = 120) => actions.push({ kind: 'command', command, reason, timeoutSec })
  const cd = root ? `cd ${JSON.stringify('/workspace/' + root)} && ` : 'cd /workspace && '

  if ((hasPackageChange || hasSrcChange || hasServerChange) && scripts.test) {
    actions.push({ kind: 'tool', tool: 'npm_test', args: {}, reason: 'package test script exists' })
  }
  if ((hasSrcChange || hasPackageChange) && scripts.build) {
    run(`${cd}${profile.packageManager === 'pnpm' ? 'pnpm run build' : profile.packageManager === 'yarn' ? 'yarn build' : profile.packageManager === 'bun' ? 'bun run build' : 'npm run build'}`, 'frontend/package build script', 180)
  }
  if (hasDockerChange && profile.dockerCompose) {
    run(`${cd}docker compose -f ${JSON.stringify(relToRoot(profile.dockerCompose))} config`, 'docker compose config validation', 60)
  }
  if (taskType === 'deploy_ops') {
    run('curl -fsS http://localhost/api/health || true', 'post-deploy/local health probe', 30)
  }

  if (!actions.length && files.some(isCode)) {
    actions.push({ kind: 'note', reason: 'No automatic verifier matched touched files.' })
  }

  return { schema: 'browserai.verification_plan.v1', root, actions }
}

export default { buildVerificationPlan }
