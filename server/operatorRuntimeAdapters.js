export const RUNTIME_ADAPTERS = [
  {
    id: 'node',
    label: 'Node.js / Frontend / API',
    match: { templates: ['node-vite-react', 'node-express-api'], stackAny: ['vite', 'react', 'express'] },
    phases: {
      inspect: ['read package.json', 'read README/AGENTS', 'inspect src/server entrypoints'],
      verify: ['install dependencies if needed', 'run lint when configured', 'run tests', 'run build'],
      fix: ['use focused test output', 'patch source/config', 'rerun verification'],
      release: ['secret scan', 'commit/PR', 'wait CI', 'deploy via policy'],
    },
    commandHints: { format: '', lint: 'npm run lint', test: 'npm test', build: 'npm run build' },
    riskHints: ['package.json and lockfiles require dependency review', 'server/auth/crypto/deploy files are high-risk'],
  },
  {
    id: 'python',
    label: 'Python API / App',
    match: { templates: ['python-api'], filesAny: ['pyproject.toml', 'requirements.txt', 'manage.py', 'app.py', 'main.py'] },
    phases: {
      inspect: ['read pyproject/requirements', 'find app entrypoint', 'inspect tests'],
      verify: ['install requirements if needed', 'run pytest', 'run ruff when configured'],
      fix: ['patch modules/tests', 'rerun failing pytest target first'],
      release: ['secret scan', 'commit/PR', 'wait CI'],
    },
    commandHints: { format: 'ruff format . || black .', lint: 'ruff check .', test: 'pytest', build: '' },
    riskHints: ['settings.py/.env/auth files are high-risk', 'migration changes require DB review'],
  },
  {
    id: 'go',
    label: 'Go service',
    match: { templates: ['go-service'], filesAny: ['go.mod'] },
    phases: {
      inspect: ['read go.mod', 'find main packages', 'inspect tests'],
      verify: ['go test ./...', 'go vet ./...', 'go build ./...'],
      fix: ['run gofmt', 'patch packages', 'rerun go test ./...'],
      release: ['secret scan', 'commit/PR', 'wait CI'],
    },
    commandHints: { format: 'gofmt -w .', lint: 'go vet ./...', test: 'go test ./...', build: 'go build ./...' },
    riskHints: ['go.mod/go.sum changes require dependency review'],
  },
  {
    id: 'rust',
    label: 'Rust service',
    match: { templates: ['rust-service'], filesAny: ['Cargo.toml'] },
    phases: {
      inspect: ['read Cargo.toml', 'inspect src and tests'],
      verify: ['cargo fmt --check', 'cargo clippy -- -D warnings', 'cargo test', 'cargo build'],
      fix: ['cargo fmt', 'patch modules', 'rerun cargo test'],
      release: ['secret scan', 'commit/PR', 'wait CI'],
    },
    commandHints: { format: 'cargo fmt', lint: 'cargo clippy -- -D warnings', test: 'cargo test', build: 'cargo build' },
    riskHints: ['Cargo.lock changes require dependency review'],
  },
  {
    id: 'docker',
    label: 'Docker / Compose app',
    match: { templates: ['docker-compose-app'], stackAny: ['docker', 'docker-compose'], filesAny: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'] },
    phases: {
      inspect: ['read Dockerfile/compose', 'inspect exposed ports and health checks'],
      verify: ['docker compose config', 'docker compose build'],
      fix: ['patch Dockerfile/compose/env docs', 'rerun compose config/build'],
      release: ['deploy via policy', 'follow logs', 'wait health'],
    },
    commandHints: { format: '', lint: 'docker compose config', test: 'docker compose config', build: 'docker compose build' },
    riskHints: ['compose/env/volume/network changes are high-risk'],
  },
  {
    id: 'static',
    label: 'Static site',
    match: { templates: ['static-site'], filesAny: ['index.html'] },
    phases: {
      inspect: ['read HTML/CSS/JS entry files'],
      verify: ['open in browser or run static build if configured'],
      fix: ['patch HTML/CSS/JS', 'visual check if possible'],
      release: ['secret scan', 'commit/PR'],
    },
    commandHints: { format: '', lint: '', test: '', build: '' },
    riskHints: ['manual visual verification recommended'],
  },
]

function hasAny(list = [], values = []) { return values.some((v) => list.includes(v)) }
function filesFromProfile(profile = {}) {
  return [profile.packageJson, profile.dockerfile, profile.dockerCompose, ...(profile.lockfiles || []), ...(profile.entrypoints || [])]
    .filter(Boolean).map((f) => f.split('/').pop())
}

export function matchRuntimeAdapters({ profile = {}, template = null } = {}) {
  const stack = profile.stack || []
  const files = filesFromProfile(profile)
  const templateId = template?.id || template || ''
  return RUNTIME_ADAPTERS.map((a) => {
    let score = 0
    const m = a.match || {}
    if (m.templates?.includes(templateId)) score += 4
    if (m.stackAny && hasAny(stack, m.stackAny)) score += 3
    if (m.filesAny && hasAny(files, m.filesAny)) score += 2
    return { ...a, score }
  }).filter((a) => a.score > 0).sort((a, b) => b.score - a.score)
}

export function bestRuntimeAdapter(opts = {}) {
  return matchRuntimeAdapters(opts)[0] || null
}

export function buildAdapterRunbook({ adapter = null, project = {}, profile = {}, commands = {} } = {}) {
  if (!adapter) return ''
  const phaseMd = Object.entries(adapter.phases || {}).map(([k, arr]) => `### ${k}\n${(arr || []).map((x) => `- ${x}`).join('\n')}`).join('\n\n')
  return `# ${adapter.label} Adapter Runbook\n\nProject: ${project.name || project.id || ''}\n\n## Detected\n\n- Adapter: \`${adapter.id}\`\n- Stack: ${(profile.stack || []).join(', ') || 'unknown'}\n- Package manager: ${profile.packageManager || 'n/a'}\n\n## Commands\n\n- Format: \`${commands.format || adapter.commandHints?.format || ''}\`\n- Lint: \`${commands.lint || adapter.commandHints?.lint || ''}\`\n- Test: \`${commands.test || adapter.commandHints?.test || ''}\`\n- Build: \`${commands.build || adapter.commandHints?.build || ''}\`\n\n## Workflow\n\n${phaseMd}\n\n## Risk hints\n\n${(adapter.riskHints || []).map((x) => `- ${x}`).join('\n')}\n`
}

export default { RUNTIME_ADAPTERS, matchRuntimeAdapters, bestRuntimeAdapter, buildAdapterRunbook }
