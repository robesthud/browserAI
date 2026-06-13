import fs from 'node:fs/promises'
import path from 'node:path'
import { safePath } from './workspace.js'

const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache'])

async function exists(rel = '') {
  try { await fs.access(safePath(rel)); return true } catch { return false }
}

async function readJson(rel) {
  try { return JSON.parse(await fs.readFile(safePath(rel), 'utf8')) } catch { return null }
}

async function findFiles(dirRel = '', names = new Set(), depth = 0, out = []) {
  if (depth > 3 || out.length > 40) return out
  let entries = []
  try { entries = await fs.readdir(safePath(dirRel), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (EXCLUDED.has(e.name)) continue
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name
    if (e.isFile() && names.has(e.name)) out.push(rel)
    else if (e.isDirectory()) await findFiles(rel, names, depth + 1, out)
  }
  return out
}

function detectPackageManager(root = '', lockfiles = []) {
  const base = (name) => root ? `${root}/${name}` : name
  if (lockfiles.includes(base('pnpm-lock.yaml'))) return 'pnpm'
  if (lockfiles.includes(base('yarn.lock'))) return 'yarn'
  if (lockfiles.includes(base('bun.lockb')) || lockfiles.includes(base('bun.lock'))) return 'bun'
  if (lockfiles.includes(base('package-lock.json'))) return 'npm'
  return 'npm'
}

function detectStack(pkg = {}, files = []) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name)
  const stack = []
  if (has('vite')) stack.push('vite')
  if (has('react')) stack.push('react')
  if (has('express')) stack.push('express')
  if (has('better-sqlite3') || has('sqlite3')) stack.push('sqlite')
  if (has('tailwindcss')) stack.push('tailwind')
  if (files.some((f) => /docker-compose\.ya?ml$/i.test(f))) stack.push('docker-compose')
  if (files.some((f) => /Dockerfile$/i.test(f))) stack.push('docker')
  return [...new Set(stack)]
}

function pickEntrypoints(root = '', files = []) {
  const candidates = ['server/index.js', 'src/main.jsx', 'src/main.tsx', 'src/App.jsx', 'index.js', 'index.mjs']
  return candidates.map((f) => root ? `${root}/${f}` : f).filter((f) => files.includes(f))
}

export async function buildProjectProfile({ preferredRoot = '' } = {}) {
  const importantNames = new Set([
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
    'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile', 'vite.config.js', 'vite.config.ts',
    'README.md', 'AGENTS.md', 'index.js', 'index.mjs', 'main.jsx', 'main.tsx', 'App.jsx', 'App.tsx',
  ])
  const files = await findFiles('', importantNames)
  const packageFiles = files.filter((f) => f.endsWith('package.json'))
  let root = preferredRoot.replace(/^\/+|\/+$/g, '')
  if (!root || !(await exists(root ? `${root}/package.json` : 'package.json'))) {
    root = packageFiles[0] ? path.posix.dirname(packageFiles[0]) : ''
    if (root === '.') root = ''
  }
  const pkgPath = root ? `${root}/package.json` : 'package.json'
  const pkg = await readJson(pkgPath) || {}
  const rootFiles = files.filter((f) => !root || f === root || f.startsWith(`${root}/`))
  const lockfiles = rootFiles.filter((f) => /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock)$/i.test(f))
  const packageManager = detectPackageManager(root, lockfiles)
  const scripts = pkg.scripts || {}
  const stack = detectStack(pkg, rootFiles)
  const entrypoints = pickEntrypoints(root, rootFiles)
  const dockerCompose = rootFiles.find((f) => /docker-compose\.ya?ml$/i.test(f)) || ''
  const dockerfile = rootFiles.find((f) => /Dockerfile$/i.test(f)) || ''
  return {
    schema: 'browserai.project_profile.v1',
    root,
    name: pkg.name || (root ? path.posix.basename(root) : 'workspace'),
    version: pkg.version || '',
    packageManager,
    scripts,
    stack,
    entrypoints,
    dockerCompose,
    dockerfile,
    packageJson: packageFiles[0] || '',
    lockfiles,
  }
}

export default { buildProjectProfile }
