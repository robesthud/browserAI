import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || (fsSync.existsSync('/workspace') ? '/workspace' : path.join(process.cwd(), 'workspace'))
const BASE_DIR = path.join(WORKSPACE_ROOT, '.browserai')
const RUNBOOK_DIR = path.join(BASE_DIR, 'runbooks')
const LESSONS_FILE = path.join(BASE_DIR, 'lessons.md')

const DEFAULT_RUNBOOKS = {
  'deploy.md': `# BrowserAI Deploy Runbook

## Golden path

1. Check git sync and dirty state.
2. Build image.
3. Remove stale compose replacement containers (\`*_browserai\`).
4. Start \`browserai\` and \`agent-sandbox\` via \`docker compose up -d --remove-orphans\`.
5. Wait for \`/api/health\` through host port 80.
6. Check docker logs after deploy.
7. Prune old build cache after successful deploy.

## Known lessons

- Do not check host \`localhost:8080\`; inside-container port is 8080 but host health is \`http://127.0.0.1/api/health\`.
- Remove stale git locks before fetch/reset: \`.git/index.lock\` and origin ref locks.
- Backup must not include \`/data/backups\` recursively.
`,
  'ci.md': `# CI Runbook

## When CI fails

1. Get GitHub Actions run list for the branch/commit.
2. Download failed workflow logs.
3. Extract error/failure/fatal lines.
4. Start Code Operator CI auto-fix on the same branch.
5. Verify locally with tests/build.
6. Commit, push same branch, wait CI again.

## Safety

- Do not merge until CI is green.
- Do not deploy until merge is complete and production deploy is approved.
`,
  'incidents.md': `# Incident Runbook

## Incident workflow

1. Create or dedupe incident by fingerprint.
2. Attach diagnostic workflow.
3. Generate RCA from workflow/code/deploy evidence.
4. Recommend next actions.
5. Resolve only after health/recovery is verified.

## Severity guide

- high: production health failure, CI blocking merge, auth/secret issue.
- medium: degraded automation, failed non-production workflow.
- low: informational events such as push-to-main checks.
`,
}

function safeName(name = '') {
  const n = String(name || '').trim().replace(/\\/g, '/').split('/').pop()
  if (!n || n.startsWith('.')) throw new Error('invalid runbook name')
  return n.endsWith('.md') ? n : `${n}.md`
}

async function ensureDirs() {
  await fs.mkdir(RUNBOOK_DIR, { recursive: true })
  await fs.mkdir(BASE_DIR, { recursive: true })
  for (const [name, content] of Object.entries(DEFAULT_RUNBOOKS)) {
    const file = path.join(RUNBOOK_DIR, name)
    if (!fsSync.existsSync(file)) await fs.writeFile(file, content, 'utf8')
  }
  if (!fsSync.existsSync(LESSONS_FILE)) {
    await fs.writeFile(LESSONS_FILE, '# BrowserAI Lessons Learned\n\nLessons captured by Operator Mode will appear here.\n', 'utf8')
  }
}

export async function listRunbooks() {
  await ensureDirs()
  const entries = await fs.readdir(RUNBOOK_DIR, { withFileTypes: true })
  const runbooks = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const st = await fs.stat(path.join(RUNBOOK_DIR, e.name))
    runbooks.push({ name: e.name, path: `.browserai/runbooks/${e.name}`, size: st.size, updatedAt: st.mtimeMs })
  }
  const lst = await fs.stat(LESSONS_FILE).catch(() => null)
  return { runbooks: runbooks.sort((a, b) => a.name.localeCompare(b.name)), lessons: { name: 'lessons.md', path: '.browserai/lessons.md', size: lst?.size || 0, updatedAt: lst?.mtimeMs || 0 } }
}

export async function readRunbook(name = '') {
  await ensureDirs()
  const file = name === 'lessons.md' || name === 'lessons' ? LESSONS_FILE : path.join(RUNBOOK_DIR, safeName(name))
  const text = await fs.readFile(file, 'utf8')
  return { name: path.basename(file), path: path.relative(WORKSPACE_ROOT, file).replace(/\\/g, '/'), text }
}

export async function writeRunbook(name = '', text = '') {
  await ensureDirs()
  const file = name === 'lessons.md' || name === 'lessons' ? LESSONS_FILE : path.join(RUNBOOK_DIR, safeName(name))
  await fs.writeFile(file, String(text || ''), 'utf8')
  return readRunbook(path.basename(file))
}

export async function appendLesson({ title = '', body = '', source = '', tags = [] } = {}) {
  await ensureDirs()
  const cleanTitle = String(title || 'Lesson').replace(/\n+/g, ' ').slice(0, 160)
  const cleanBody = String(body || '').trim().slice(0, 6000)
  const stamp = new Date().toISOString()
  const tagText = Array.isArray(tags) && tags.length ? `\nTags: ${tags.map((t) => `\`${String(t).slice(0, 40)}\``).join(' ')}` : ''
  const block = `\n\n## ${cleanTitle}\n\n- Time: ${stamp}\n- Source: ${source || 'operator'}${tagText}\n\n${cleanBody || '(no details)'}\n`
  await fs.appendFile(LESSONS_FILE, block, 'utf8')
  return { ok: true, path: '.browserai/lessons.md', title: cleanTitle }
}

export async function captureLessonFromRca({ incident = null, rca = null, workflow = null } = {}) {
  const title = `RCA: ${rca?.primaryCategory || 'incident'}${incident?.title ? ` — ${incident.title}` : ''}`
  const body = [
    rca?.summary || '',
    '',
    '### Evidence',
    ...(rca?.evidence || []).slice(0, 5).map((e) => `- ${e.title || e.idx}: ${e.error || e.category || ''}`),
    '',
    '### Recommended actions',
    ...(rca?.recommendedActions || []).map((a) => `- ${a}`),
    workflow?.id ? `\nWorkflow: ${workflow.id}` : '',
  ].filter(Boolean).join('\n')
  return appendLesson({ title, body, source: incident?.id || workflow?.id || 'rca', tags: ['rca', rca?.primaryCategory || 'incident'] })
}

export async function renderRunbooksForPrompt({ maxChars = 12000 } = {}) {
  await ensureDirs()
  const files = ['deploy.md', 'ci.md', 'incidents.md']
  const parts = []
  for (const f of files) {
    try {
      const rb = await readRunbook(f)
      parts.push(`## ${rb.name}\n${rb.text}`)
    } catch { /* optional */ }
  }
  try {
    const lessons = await readRunbook('lessons')
    parts.push(`## lessons.md\n${lessons.text.split('\n').slice(-80).join('\n')}`)
  } catch { /* optional */ }
  const text = parts.join('\n\n---\n\n')
  return text.length > maxChars ? text.slice(-maxChars) : text
}

export default { listRunbooks, readRunbook, writeRunbook, appendLesson, renderRunbooksForPrompt, captureLessonFromRca }
