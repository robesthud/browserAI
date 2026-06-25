import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { buildProjectProfile } from './projectProfiler.js'
import { withWorkspaceScope } from './workspace.js'
import { upsertOperatorProject } from './operatorMode.js'
import { writeRunbook } from './operatorRunbooks.js'
import { bestProjectTemplate, matchProjectTemplates, mergeTemplateCommands } from './operatorProjectTemplates.js'
import { bestRuntimeAdapter, matchRuntimeAdapters, buildAdapterRunbook } from './operatorRuntimeAdapters.js'

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || (fsSync.existsSync('/workspace') ? '/workspace' : path.join(process.cwd(), 'workspace'))
const PROJECTS_ROOT = path.join(WORKSPACE_ROOT, 'projects')

function shQuote(v = '') { return `'${String(v).replace(/'/g, `'"'"'`)}'` }
function clip(s = '', max = 12000) { const x = String(s || ''); return x.length > max ? x.slice(0, max) + `\n…[truncated ${x.length - max} chars]` : x }
function safeId(value = '') {
  return String(value || 'project').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project'
}
function repoSlug(repo = '') { return String(repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '') }
function repoToUrl(repo = '') {
  const s = String(repo || '').trim()
  if (/^https?:|^git@/.test(s)) return s
  return `https://github.com/${s.replace(/^\/+|\/+$/g, '')}.git`
}
function repoToDir(repo = '') { return safeId(repoSlug(repo).split('/').pop() || repo || 'project') }

function run(command, { cwd = WORKSPACE_ROOT, timeoutMs = 5 * 60_000 } = {}) {
  const RUN_LIMIT = 4 * 1024 * 1024  // OPO-2: 4 MB per stream
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []; const err = []; let outLen = 0; let errLen = 0
    let killed = false
    const timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
    proc.stdout.on('data', (c) => { if (outLen < RUN_LIMIT) { out.push(c); outLen += c.length } })
    proc.stderr.on('data', (c) => { if (errLen < RUN_LIMIT) { err.push(c); errLen += c.length } })
    proc.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: killed ? 124 : (code ?? 1), stdout: clip(Buffer.concat(out).toString()), stderr: clip(Buffer.concat(err).toString()) + (killed ? '\n[killed]' : '') }) })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: 1, stdout: '', stderr: e.message }) })
  })
}

async function fileExists(abs) { try { await fs.access(abs); return true } catch { return false } }
async function readJson(abs) { try { return JSON.parse(await fs.readFile(abs, 'utf8')) } catch { return null } }

export function inferCommands({ profile = {}, rootAbs = '' } = {}) {
  const pm = profile.packageManager || 'npm'
  const scripts = profile.scripts || {}
  const hasScript = (name) => Object.prototype.hasOwnProperty.call(scripts, name)
  const runScript = (name) => {
    if (!hasScript(name)) return ''
    if (pm === 'npm') return name === 'test' ? 'npm test' : `npm run ${name}`
    if (pm === 'pnpm') return name === 'test' ? 'pnpm test' : `pnpm ${name}`
    if (pm === 'yarn') return name === 'test' ? 'yarn test' : `yarn ${name}`
    if (pm === 'bun') return name === 'test' ? 'bun test' : `bun run ${name}`
    return `npm run ${name}`
  }
  let install = ''
  if (profile.packageJson) {
    if (pm === 'pnpm') install = 'pnpm install --frozen-lockfile'
    else if (pm === 'yarn') install = 'yarn install --frozen-lockfile'
    else if (pm === 'bun') install = 'bun install'
    else install = profile.lockfiles?.some((f) => f.endsWith('package-lock.json')) ? 'npm ci --include=dev' : 'npm install'
  }
  let test = runScript('test')
  let build = runScript('build')
  let lint = runScript('lint')

  if (!profile.packageJson && rootAbs) {
    if (fsSync.existsSync(path.join(rootAbs, 'pyproject.toml')) || fsSync.existsSync(path.join(rootAbs, 'requirements.txt'))) {
      install = fsSync.existsSync(path.join(rootAbs, 'requirements.txt')) ? 'python3 -m pip install -r requirements.txt' : ''
      test = 'pytest'
    } else if (fsSync.existsSync(path.join(rootAbs, 'go.mod'))) {
      test = 'go test ./...'
      build = 'go build ./...'
    } else if (fsSync.existsSync(path.join(rootAbs, 'Cargo.toml'))) {
      test = 'cargo test'
      build = 'cargo build'
    }
  }
  return { install, test, build, lint }
}

export function generateProjectRunbook({ project = {}, profile = {}, commands = {} } = {}) {
  return `# ${project.name || project.id || 'Project'} Runbook

Generated: ${new Date().toISOString()}

## Project

- ID: \`${project.id || ''}\`
- Repo: \`${project.repo || ''}\`
- Local path: \`${project.localPath || ''}\`
- Production path: \`${project.productionPath || ''}\`
- Default branch: \`${project.defaultBranch || 'main'}\`

## Template

- Template: ${project.meta?.template?.label || project.meta?.template?.id || 'auto'}

## Detected stack

- Stack: ${(profile.stack || []).join(', ') || 'unknown'}
- Package manager: ${profile.packageManager || 'n/a'}
- Root: \`${profile.root || '.'}\`
- Entrypoints: ${(profile.entrypoints || []).map((x) => `\`${x}\``).join(', ') || 'n/a'}
- Docker: ${profile.dockerfile || profile.dockerCompose ? 'yes' : 'no'}

## Commands

- Install: \`${commands.install || '(none)'}\`
- Test: \`${commands.test || '(none)'}\`
- Build: \`${commands.build || '(none)'}\`
- Lint: \`${commands.lint || '(none)'}\`

## Operator workflow

1. Read this runbook and project rules.
2. Work on an operator branch, never directly on production.
3. Run the configured test/build/lint commands when available.
4. Run secret scan before commit/push/deploy.
5. Create PR and wait CI before merge.
6. Deploy only through the configured deployment recipe and approval policy.
`
}

export async function analyzeOperatorProject({ userId = '', repo = '', id = '', name = '', localPath = '', productionPath = '', defaultBranch = 'main', generateRunbook = true } = {}) {
  if (!repo) throw new Error('repo is required')
  // OPO-1: SSRF guard — block git clone to internal/loopback hosts
  const repoUrlStr = repoToUrl(repo)
  try {
    const { isBlockedHost } = await import('./ssrf.js')
    const _u = new URL(repoUrlStr)
    if (isBlockedHost(_u.hostname)) throw new Error(`Blocked internal host in repo URL: ${_u.hostname}`)
  } catch (e) { if (e.message?.includes('Blocked')) throw e /* re-throw SSRF errors */ }
  const projectId = safeId(id || repoSlug(repo).replace('/', '-'))
  const projectName = name || repoSlug(repo).split('/').pop() || projectId
  const target = localPath || path.join(PROJECTS_ROOT, repoToDir(repo))
  await fs.mkdir(path.dirname(target), { recursive: true })
  if (!(await fileExists(path.join(target, '.git')))) {
    const r = await run(`git clone ${shQuote(repoToUrl(repo))} ${shQuote(target)}`, { timeoutMs: 5 * 60_000 })
    if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr || r.stdout}`)
  } else {
    await run(`rm -f .git/index.lock .git/refs/remotes/origin/*.lock 2>/dev/null || true && git fetch --all --prune || true`, { cwd: target, timeoutMs: 2 * 60_000 })
  }
  const relRoot = path.relative(WORKSPACE_ROOT, target).replace(/\\/g, '/')
  const profile = await withWorkspaceScope('', () => buildProjectProfile({ preferredRoot: relRoot }))
  const rootAbs = path.join(WORKSPACE_ROOT, profile.root || relRoot)
  const inferredCommands = inferCommands({ profile, rootAbs })
  const matchedTemplates = matchProjectTemplates(profile)
  const template = bestProjectTemplate(profile)
  const adapter = bestRuntimeAdapter({ profile, template })
  const matchedAdapters = matchRuntimeAdapters({ profile, template })
  const commands = mergeTemplateCommands(inferredCommands, template, profile.packageManager)
  if (adapter?.commandHints) {
    for (const [k, v] of Object.entries(adapter.commandHints)) {
      if (!commands[k] && v) commands[k] = v
    }
  }
  const pkg = profile.packageJson ? await readJson(path.join(WORKSPACE_ROOT, profile.packageJson)) : null
  const healthUrl = 'http://127.0.0.1/api/health'
  const meta = {
    analyzedAt: new Date().toISOString(),
    profile,
    template: template ? { id: template.id, label: template.label, score: template.score, notes: template.notes || [] } : null,
    runtimeAdapter: adapter ? { id: adapter.id, label: adapter.label, score: adapter.score, riskHints: adapter.riskHints || [], phases: adapter.phases || {} } : null,
    matchedAdapters: matchedAdapters.map((a) => ({ id: a.id, label: a.label, score: a.score })),
    matchedTemplates: matchedTemplates.map((t) => ({ id: t.id, label: t.label, score: t.score })),
    package: pkg ? { name: pkg.name, version: pkg.version, scripts: pkg.scripts || {} } : null,
    commands,
    deploy: { recipe: 'browserai_deploy_safe', healthUrl, productionPath: productionPath || '' },
    git: { defaultBranch, branchPrefix: 'operator', prBase: defaultBranch },
    runbooks: [`project-${projectId}.md`, 'deploy.md', 'ci.md', 'incidents.md'],
  }
  const project = upsertOperatorProject({ userId, id: projectId, name: projectName, repo: repoSlug(repo), localPath: target, productionPath: productionPath || '', defaultBranch, meta })
  let runbook = null
  if (generateRunbook) {
    runbook = await writeRunbook(`project-${projectId}.md`, generateProjectRunbook({ project, profile, commands }) + (adapter ? `\n\n---\n\n${buildAdapterRunbook({ adapter, project, profile, commands })}` : ''))
  }
  return { project, profile, commands, template: meta.template, matchedTemplates: meta.matchedTemplates, runtimeAdapter: meta.runtimeAdapter, matchedAdapters: meta.matchedAdapters, runbook }
}

export default { analyzeOperatorProject, inferCommands, generateProjectRunbook }
