export const PROJECT_TEMPLATES = [
  {
    id: 'node-vite-react',
    label: 'Node / Vite / React',
    match: { stackAny: ['vite', 'react'], filesAny: ['vite.config.js', 'vite.config.ts'] },
    commands: { install: 'npm ci --include=dev', test: 'npm test', build: 'npm run build', lint: 'npm run lint' },
    runbooks: ['deploy.md', 'ci.md', 'incidents.md'],
    notes: ['Use npm/pnpm/yarn according to lockfile.', 'Run build before deploy.', 'Check browser console/UI after frontend changes.'],
  },
  {
    id: 'node-express-api',
    label: 'Node / Express API',
    match: { stackAny: ['express'], filesAny: ['server/index.js', 'index.js'] },
    commands: { install: 'npm ci --include=dev', test: 'npm test', build: 'npm run build', lint: 'npm run lint' },
    runbooks: ['ci.md', 'incidents.md'],
    notes: ['Run API smoke tests after backend changes.', 'Check logs and health endpoints after deploy.'],
  },
  {
    id: 'python-api',
    label: 'Python API / App',
    match: { filesAny: ['pyproject.toml', 'requirements.txt', 'manage.py', 'app.py', 'main.py'] },
    commands: { install: 'python3 -m pip install -r requirements.txt', test: 'pytest', build: '', lint: 'ruff check .' },
    runbooks: ['ci.md', 'incidents.md'],
    notes: ['Prefer virtualenv in real deployments.', 'Run pytest after edits.', 'Use ruff when configured.'],
  },
  {
    id: 'go-service',
    label: 'Go service',
    match: { filesAny: ['go.mod'] },
    commands: { install: 'go mod download', test: 'go test ./...', build: 'go build ./...', lint: 'go vet ./...' },
    runbooks: ['ci.md', 'incidents.md'],
    notes: ['Run gofmt before commit.', 'Run go test ./... and go vet ./...'],
  },
  {
    id: 'rust-service',
    label: 'Rust service',
    match: { filesAny: ['Cargo.toml'] },
    commands: { install: 'cargo fetch', test: 'cargo test', build: 'cargo build', lint: 'cargo clippy -- -D warnings' },
    runbooks: ['ci.md', 'incidents.md'],
    notes: ['Run cargo fmt/clippy/test before PR.'],
  },
  {
    id: 'docker-compose-app',
    label: 'Docker Compose App',
    match: { stackAny: ['docker-compose'], filesAny: ['docker-compose.yml', 'docker-compose.yaml'] },
    commands: { install: '', test: 'docker compose config', build: 'docker compose build', lint: '' },
    runbooks: ['deploy.md', 'incidents.md'],
    notes: ['Use docker compose config/build as verification.', 'Check container logs and health after deploy.'],
  },
  {
    id: 'static-site',
    label: 'Static site',
    match: { filesAny: ['index.html'], stackNone: ['react', 'express'] },
    commands: { install: '', test: '', build: '', lint: '' },
    runbooks: ['ci.md'],
    notes: ['Validate HTML/CSS manually or via browser screenshot.'],
  },
]

function hasAny(list = [], values = []) {
  return values.some((v) => list.includes(v))
}
function fileBaseList(profile = {}) {
  return [
    ...(profile.lockfiles || []), profile.packageJson, profile.dockerCompose, profile.dockerfile,
    ...(profile.entrypoints || []),
  ].filter(Boolean).map((f) => f.split('/').pop())
}

export function matchProjectTemplates(profile = {}) {
  const stack = profile.stack || []
  const files = fileBaseList(profile)
  return PROJECT_TEMPLATES.map((tpl) => {
    let score = 0
    const m = tpl.match || {}
    if (m.stackAny && hasAny(stack, m.stackAny)) score += 3
    if (m.filesAny && hasAny(files, m.filesAny)) score += 2
    if (m.stackNone && hasAny(stack, m.stackNone)) score -= 4
    return { ...tpl, score }
  }).filter((t) => t.score > 0).sort((a, b) => b.score - a.score)
}

export function bestProjectTemplate(profile = {}) {
  return matchProjectTemplates(profile)[0] || null
}

export function mergeTemplateCommands(base = {}, template = null, packageManager = 'npm') {
  const t = template?.commands || {}
  const out = { ...t, ...Object.fromEntries(Object.entries(base || {}).filter(([, v]) => v != null && v !== '')) }
  if (packageManager === 'pnpm') {
    if (out.install?.startsWith('npm ')) out.install = 'pnpm install --frozen-lockfile'
    if (out.test === 'npm test') out.test = 'pnpm test'
    if (out.build === 'npm run build') out.build = 'pnpm build'
    if (out.lint === 'npm run lint') out.lint = 'pnpm lint'
  }
  if (packageManager === 'yarn') {
    if (out.install?.startsWith('npm ')) out.install = 'yarn install --frozen-lockfile'
    if (out.test === 'npm test') out.test = 'yarn test'
    if (out.build === 'npm run build') out.build = 'yarn build'
    if (out.lint === 'npm run lint') out.lint = 'yarn lint'
  }
  return out
}

export default { PROJECT_TEMPLATES, matchProjectTemplates, bestProjectTemplate, mergeTemplateCommands }
