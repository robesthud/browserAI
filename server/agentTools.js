/**
 * agentTools.js — Enhanced Registry
 *
 * New tools: npm_install, npm_test, git_status, git_commit, docker_logs, verify_code
 */
import {
  getWorkspaceTree,
  readWorkspaceFile,
  createFile,
  createFolder,
  writeFileContent,
  deleteItem,
  searchWorkspaceContent,
  getContainerWorkspaceRoot,
  safePath,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'
import { runSandboxCommand } from './agentSandbox.js'
import { upsertFact, forgetFact, listFacts } from './userMemory.js'
import { addDocument, deleteDocument, listDocuments, searchKnowledge } from './knowledgeBase.js'
import { fetchViaProxy, isGoogleGenerativeNativeUrl } from './llmClient.js'
import { writeFile as fsWriteFile, readFile as fsReadFile, mkdir as fsMkdir, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import path from 'node:path'
import { browserOpen, browserScreenshot, browserClick, browserType, browserClose } from './browserTools.js'
import { computerScreenshot, computerClick, computerType, computerOpenApp, computerStatus } from './computerUse.js'
import { listOpsServices, runOpsAction } from './ops.js'
import { buildProjectProfile } from './projectProfiler.js'
import { buildVerificationPlan } from './verifyOrchestrator.js'
import { scanSecrets } from './secretScan.js'
import { createWorkspaceSnapshot, listWorkspaceSnapshots, restoreWorkspaceSnapshot } from './workspaceSnapshots.js'

function safeJsonParse(text) { try { return JSON.parse(text) } catch { return null } }


function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\''`)}'`
}

function scopedContainerRoot() {
  return getContainerWorkspaceRoot().replace(/\/+$/, '') || '/workspace'
}

function rewriteWorkspacePaths(command = '') {
  const root = scopedContainerRoot()
  if (root === '/workspace') return String(command)
  return String(command).replace(/\/workspace(?=\/|\s|&&|;|\)|$)/g, root)
}

async function runWorkspaceCommand(command, { timeoutMs = 120_000, signal, onStdout, onStderr } = {}) {
  const root = scopedContainerRoot()
  const prepared = `mkdir -p ${shQuote(root)} && cd ${shQuote(root)} && ${rewriteWorkspacePaths(command)}`
  return runSandboxCommand({ command: prepared, cwd: '/', timeoutMs, signal, onStdout, onStderr })
}

function defaultCloneDir(url = '') {
  const tail = String(url).replace(/\/+$/, '').split('/').pop() || 'repo'
  return tail.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo'
}

const ZIP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.vite', '.turbo', '.history', '.snapshots'])
const ZIP_EXCLUDED_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa|id_ed25519|\.netrc|credentials|secrets?\.(json|ya?ml|env))$/i

async function addPathToZip(zip, abs, zipRel, outputAbs) {
  const st = await fsStat(abs)
  if (st.isDirectory()) {
    const base = path.basename(abs)
    if (ZIP_EXCLUDED_DIRS.has(base)) return
    const entries = await fsReaddir(abs, { withFileTypes: true })
    if (entries.length === 0 && zipRel) zip.addFile(zipRel.replace(/\\/g, '/') + '/.keep', Buffer.alloc(0))
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name)
      const childRel = zipRel ? `${zipRel}/${entry.name}` : entry.name
      await addPathToZip(zip, childAbs, childRel, outputAbs)
    }
    return
  }
  if (!st.isFile()) return
  if (ZIP_EXCLUDED_FILE_RE.test(zipRel)) return
  if (path.resolve(abs) === path.resolve(outputAbs)) return
  if (st.size > 50 * 1024 * 1024) return
  const data = await fsReadFile(abs)
  zip.addFile(zipRel.replace(/\\/g, '/'), data)
}

function truncate(str, max = 8000) {
  const s = String(str ?? '')
  return s.length > max ? s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]` : s
}
function ok(result) { return { ok: true, result } }
function err(message) { return { ok: false, error: String(message || 'unknown error') } }

// ── Helper: ensure parent dirs exist ───────────────────────────────────────
async function ensureParentDirs(relPath) {
  const parts = String(relPath).split('/').filter(Boolean)
  parts.pop() // remove filename
  let acc = ''
  for (const seg of parts) {
    const here = acc ? acc + '/' + seg : seg
    try { await createFolder(acc, seg) } catch { /* exists */ }
    acc = here
  }
}

export const TOOLS = {


  plan_set: {
    description: 'Publish or replace the visible task plan. Use for multi-step work.',
    params: {
      plan: { type: 'string', required: true, description: 'Markdown checklist, one step per line.' },
    },
    handler: async ({ plan } = {}) => {
      const lines = String(plan || '').split('\n').map(l => l.trim()).filter(Boolean)
      const steps = lines.map((line, i) => ({ idx: i + 1, text: line.replace(/^[-*]\s*\[[ x]\]\s*/i, '').replace(/^[-*]\s*/, ''), done: false }))
      return ok({ title: 'Plan', steps })
    },
  },

  plan_check: {
    description: 'Mark one or more visible plan steps as done.',
    params: {
      steps: { type: 'array', optional: true, description: 'Step indexes to mark done.' },
      step: { type: 'number', optional: true, description: 'Single step index to mark done.' },
    },
    handler: async ({ steps, step } = {}) => {
      const checked = Array.isArray(steps) ? steps : (step ? [step] : [])
      return ok({ checked: checked.map(Number).filter(Boolean) })
    },
  },

  ask_user: {
    description: 'Ask the user a focused question in the UI. Use only when blocked or before risky/destructive operations.',
    params: {
      question: { type: 'string', optional: true, description: 'Single question text.' },
      options: { type: 'array', optional: true, description: 'Options for single-question mode.' },
      questions: { type: 'array', optional: true, description: 'Array of question cards.' },
    },
    handler: async () => ok({ queued: true }),
  },

  recall_facts: {
    description: 'List remembered cross-session facts for this user.',
    params: {},
    handler: async ({ _userId } = {}) => {
      try { return ok({ facts: listFacts(_userId || '') }) } catch (e) { return err(e.message) }
    },
  },

  remember_fact: {
    description: 'Remember a stable key/value fact about the user or project for future chats.',
    params: {
      key: { type: 'string', required: true, description: 'Short stable key.' },
      value: { type: 'string', required: true, description: 'Fact value, max 1KB.' },
    },
    handler: async ({ key, value, _userId } = {}) => {
      try { return ok(upsertFact(_userId || '', key, value)) } catch (e) { return err(e.message) }
    },
  },

  forget_fact: {
    description: 'Forget a remembered fact by key.',
    params: { key: { type: 'string', required: true, description: 'Fact key to delete.' } },
    handler: async ({ key, _userId } = {}) => {
      try { return ok(forgetFact(_userId || '', key)) } catch (e) { return err(e.message) }
    },
  },

  kb_search: {
    description: 'Search the personal knowledge base.',
    params: {
      query: { type: 'string', required: true, description: 'Search query.' },
      topK: { type: 'number', optional: true, description: 'Max passages, default 5.' },
    },
    handler: async ({ query, topK = 5, _userId } = {}) => {
      try { return ok({ results: searchKnowledge(_userId || '', query, { topK }) }) } catch (e) { return err(e.message) }
    },
  },

  kb_list: {
    description: 'List documents in the personal knowledge base.',
    params: {},
    handler: async ({ _userId } = {}) => {
      try { return ok({ documents: listDocuments(_userId || '') }) } catch (e) { return err(e.message) }
    },
  },

  kb_add: {
    description: 'Add a document to the personal knowledge base.',
    params: {
      title: { type: 'string', required: true, description: 'Document title.' },
      text: { type: 'string', required: true, description: 'Document text.' },
      source: { type: 'string', optional: true, description: 'Optional source URL/path.' },
    },
    handler: async ({ title, text, source = '', _userId } = {}) => {
      try { return ok(addDocument(_userId || '', { title, text, source })) } catch (e) { return err(e.message) }
    },
  },

  kb_delete: {
    description: 'Delete a document from the personal knowledge base by id.',
    params: { id: { type: 'string', required: true, description: 'Document id.' } },
    handler: async ({ id, _userId } = {}) => {
      try { return ok(deleteDocument(_userId || '', id)) } catch (e) { return err(e.message) }
    },
  },

  list_files: {
    description: 'List files and folders in the workspace as a tree. Use this first to discover what is available.',
    params: {
      path: { type: 'string', optional: true, description: 'Subfolder path relative to workspace root. Empty = root.' },
      show_hidden: { type: 'boolean', optional: true, description: 'Include dotfiles. Default: false.' },
    },
    handler: async ({ path = '', show_hidden = false } = {}) => {
      try {
        const tree = await getWorkspaceTree(Boolean(show_hidden))
        if (path) {
          const parts = String(path).split('/').filter(Boolean)
          let node = tree
          for (const part of parts) {
            const children = Array.isArray(node?.children) ? node.children : []
            const next = children.find(c => c.name === part)
            if (!next) return err(`Path not found: ${path}`)
            node = next
          }
          return ok(node)
        }
        return ok(tree)
      } catch (e) { return err(e.message) }
    },
  },

  read_file: {
    description: 'Read the full contents of a text file from the workspace.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root, e.g. "src/app.js".' },
    },
    handler: async ({ path } = {}) => {
      if (!path) return err('path is required')
      try {
        const file = await readWorkspaceFile(path)
        if (!file?.text && !file?.content) {
          return err(`File is binary or empty: ${path} (mime=${file?.mime})`)
        }
        return ok({ path, content: truncate(file.text ?? file.content, 20000), mime: file.mime })
      } catch (e) { return err(e.message) }
    },
  },

  search_files: {
    description: 'Search file contents in the workspace by substring or regex. Returns matches with line numbers.',
    params: {
      query: { type: 'string', required: true, description: 'Substring to grep for.' },
    },
    handler: async ({ query } = {}) => {
      if (!query) return err('query is required')
      try {
        const results = await searchWorkspaceContent(String(query), false)
        return ok({ count: results.length, matches: results.slice(0, 30) })
      } catch (e) { return err(e.message) }
    },
  },

  write_file: {
    description: 'Create or fully overwrite a text file in the workspace. ALWAYS call verify_code immediately after to catch syntax errors.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root.' },
      content: { type: 'string', required: true, description: 'Full file contents to write.' },
    },
    handler: async ({ path, content = '' } = {}) => {
      if (!path) return err('path is required')
      try {
        await ensureParentDirs(path)
        const parts = String(path).split('/').filter(Boolean)
        const name = parts.pop()
        const parent = parts.join('/')
        try {
          await createFile(parent, name, String(content))
        } catch {
          await writeFileContent(path, String(content))
        }
        return ok({ path, bytes: Buffer.byteLength(String(content), 'utf8'), hint: 'Call verify_code next to check syntax.' })
      } catch (e) { return err(e.message) }
    },
  },

  edit_file: {
    description: 'Replace a specific substring inside an existing file. Use this for small surgical edits instead of rewriting the whole file. Fails if the old_text is not found exactly once.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root.' },
      old_text: { type: 'string', required: true, description: 'Exact substring to find. Must appear exactly once.' },
      new_text: { type: 'string', required: true, description: 'Replacement text. Use empty string to delete.' },
    },
    handler: async ({ path, old_text, new_text = '' } = {}) => {
      if (!path || old_text == null) return err('path and old_text are required')
      try {
        const file = await readWorkspaceFile(path)
        const original = file?.text ?? file?.content
        if (typeof original !== 'string') return err(`File is binary or unreadable: ${path}`)
        const count = original.split(old_text).length - 1
        if (count === 0) return err(`old_text not found in ${path}`)
        if (count > 1) return err(`old_text appears ${count} times in ${path}; refine to make it unique`)
        const updated = original.replace(old_text, String(new_text))
        await writeFileContent(path, updated)
        return ok({ path, replaced: 1, newLength: updated.length, hint: 'Call verify_code next to check syntax.' })
      } catch (e) { return err(e.message) }
    },
  },

  create_folder: {
    description: 'Create a folder in the current chat workspace.',
    params: {
      path: { type: 'string', required: true, description: 'Folder path relative to workspace root.' },
    },
    handler: async ({ path } = {}) => {
      if (!path) return err('path is required')
      try {
        const parts = String(path).split('/').filter(Boolean)
        const name = parts.pop()
        const parent = parts.join('/')
        await createFolder(parent, name)
        return ok({ path, visible_in_files: true })
      } catch (e) { return err(e.message) }
    },
  },

  rename_item: {
    description: 'Rename a file or folder in the current chat workspace.',
    params: {
      path: { type: 'string', required: true, description: 'Existing file/folder path.' },
      new_name: { type: 'string', required: true, description: 'New basename, not a full path.' },
    },
    handler: async ({ path, new_name } = {}) => {
      if (!path || !new_name) return err('path and new_name are required')
      try {
        await renameItem(path, new_name)
        const parent = String(path).split('/').filter(Boolean).slice(0, -1).join('/')
        const newPath = parent ? `${parent}/${new_name}` : String(new_name)
        return ok({ path: newPath, old_path: path, visible_in_files: true })
      } catch (e) { return err(e.message) }
    },
  },

  delete_file: {
    description: 'Delete a file or folder from the workspace. Folders are deleted recursively. Use with care.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root.' },
    },
    handler: async ({ path } = {}) => {
      if (!path) return err('path is required')
      try {
        await deleteItem(path)
        return ok({ deleted: path })
      } catch (e) { return err(e.message) }
    },
  },

  web_search: {
    description: 'Search the public web via DuckDuckGo. Returns up to 5 results with title, url and snippet.',
    params: {
      query: { type: 'string', required: true, description: 'Search query.' },
      limit: { type: 'number', optional: true, description: 'Max results, default 5, max 10.' },
    },
    handler: async ({ query, limit = 5 } = {}) => {
      if (!query) return err('query is required')
      try {
        const data = await searchWeb(String(query), Math.min(10, Math.max(1, Number(limit) || 5)))
        return ok({ query, results: data?.results || [] })
      } catch (e) { return err(e.message) }
    },
  },

  web_fetch: {
    description: 'Fetch a web page and return its text content (HTML stripped).',
    params: {
      url: { type: 'string', required: true, description: 'Full URL starting with http:// or https://' },
    },
    handler: async ({ url } = {}) => {
      if (!url) return err('url is required')
      try {
        const page = await fetchWebPage(String(url))
        return ok({ url, title: page?.title || '', content: truncate(page?.content || page?.text || '', 12000) })
      } catch (e) { return err(e.message) }
    },
  },

  bash: {
    description: 'Run a shell command inside an isolated Linux sandbox that has the workspace mounted at /workspace. Useful for git, npm, node, curl, grep, build steps, etc. Output is returned. Timeout 30s default, max 120s.',
    params: {
      command: { type: 'string', required: true, description: 'Shell command, e.g. "ls -la /workspace" or "node -e \"console.log(1+1)\""' },
      timeout_sec: { type: 'number', optional: true, description: 'Max seconds, default 30, max 120.' },
    },
    handler: async ({ command, timeout_sec = 30 } = {}) => {
      if (!command) return err('command is required')
      try {
        const r = await runWorkspaceCommand(String(command), {
          timeoutMs: Math.min(120_000, Math.max(1_000, Number(timeout_sec) * 1000 || 30_000)),
        })
        return ok({
          stdout: truncate(r.stdout, 6000),
          stderr: truncate(r.stderr, 3000),
          exitCode: r.exitCode,
          truncated: r.truncated || false,
        })
      } catch (e) { return err(e.message) }
    },
  },

  // ── NEW: npm ─────────────────────────────────────────────────────────────
  npm_install: {
    description: 'Install an npm package into the project. Use this when you need a new dependency. After installing, call verify_code on the file that imports it.',
    params: {
      package: { type: 'string', required: true, description: 'Package name, e.g. "node-telegram-bot-api" or "node-telegram-bot-api@0.66.0"' },
      dev: { type: 'boolean', optional: true, description: 'Install as devDependency. Default: false.' },
    },
    handler: async ({ package: pkg, dev = false } = {}) => {
      if (!pkg) return err('package is required')
      try {
        const flag = dev ? '--save-dev' : '--save'
        const r = await runWorkspaceCommand(`npm install ${flag} ${String(pkg)}`, { timeoutMs: 120_000 })
        return ok({
          stdout: truncate(r.stdout, 6000),
          stderr: truncate(r.stderr, 3000),
          exitCode: r.exitCode,
          installed: pkg,
        })
      } catch (e) { return err(e.message) }
    },
  },

  secret_scan: {
    description: 'Scan workspace files for secrets/tokens before archiving, committing or deploying.',
    params: {
      root: { type: 'string', optional: true, description: 'Folder to scan, relative to workspace root. Empty = whole workspace.' },
    },
    handler: async ({ root = '' } = {}) => {
      try { return ok(await scanSecrets({ root })) } catch (e) { return err(e.message) }
    },
  },

  workspace_snapshot_create: {
    description: 'Create a rollback snapshot of the current workspace before risky edits.',
    params: { label: { type: 'string', optional: true, description: 'Snapshot label.' } },
    handler: async ({ label = 'manual' } = {}) => {
      try { return ok(await createWorkspaceSnapshot({ label })) } catch (e) { return err(e.message) }
    },
  },

  workspace_snapshot_list: {
    description: 'List rollback snapshots for the current workspace.',
    params: {},
    handler: async () => {
      try { return ok({ snapshots: await listWorkspaceSnapshots() }) } catch (e) { return err(e.message) }
    },
  },

  workspace_snapshot_restore: {
    description: 'Restore a previous workspace snapshot by id. Destructive: current files are replaced.',
    params: { id: { type: 'string', required: true, description: 'Snapshot id.' } },
    handler: async ({ id } = {}) => {
      try { return ok(await restoreWorkspaceSnapshot({ id })) } catch (e) { return err(e.message) }
    },
  },

  project_profile: {
    description: 'Inspect the current workspace and detect project root, stack, package manager, scripts, entrypoints and deploy files.',
    params: {
      root: { type: 'string', optional: true, description: 'Preferred project root relative to workspace.' },
    },
    handler: async ({ root = '' } = {}) => {
      try { return ok(await buildProjectProfile({ preferredRoot: root })) } catch (e) { return err(e.message) }
    },
  },

  verify_task: {
    description: 'Run an automatic verification plan based on touched files and project profile. Use after code/config changes instead of guessing which checks to run.',
    params: {
      touched_files: { type: 'array', optional: true, description: 'Touched file paths relative to workspace root.' },
      task_type: { type: 'string', optional: true, description: 'Task type, e.g. coding_change or deploy_ops.' },
      root: { type: 'string', optional: true, description: 'Preferred project root.' },
    },
    handler: async ({ touched_files = [], task_type = '', root = '' } = {}) => {
      try {
        const profile = await buildProjectProfile({ preferredRoot: root })
        const plan = buildVerificationPlan({ profile, touchedFiles: Array.isArray(touched_files) ? touched_files : [], taskType: task_type })
        const results = []
        for (const action of plan.actions) {
          if (action.kind === 'tool' && action.tool === 'verify_code') {
            const pathArg = action.args?.path
            const ext = String(pathArg || '').toLowerCase().split('.').pop()
            let cmd = ''
            if (['js', 'mjs', 'cjs'].includes(ext)) cmd = `node --check ${shQuote(safePath(pathArg))}`
            else if (ext === 'json') cmd = `node -e "JSON.parse(require('fs').readFileSync(${JSON.stringify(safePath(pathArg))}, 'utf8'))"`
            else { results.push({ action, ok: true, skipped: true, message: 'No syntax checker for extension' }); continue }
            const r = await runWorkspaceCommand(cmd, { timeoutMs: 30_000 })
            results.push({ action, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: truncate(r.stdout, 2000), stderr: truncate(r.stderr, 2000) })
          } else if (action.kind === 'tool' && action.tool === 'npm_test') {
            const r = await runWorkspaceCommand('npm test', { timeoutMs: 120_000 })
            results.push({ action, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: truncate(r.stdout, 3000), stderr: truncate(r.stderr, 2000) })
          } else if (action.kind === 'command') {
            const r = await runWorkspaceCommand(action.command, { timeoutMs: Math.max(1, Number(action.timeoutSec || 120)) * 1000 })
            results.push({ action, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: truncate(r.stdout, 3000), stderr: truncate(r.stderr, 2000) })
          } else {
            results.push({ action, ok: true, skipped: true })
          }
        }
        const passed = results.every((r) => r.ok)
        return ok({ profile, plan, results, passed })
      } catch (e) { return err(e.message) }
    },
  },

  npm_test: {
    description: 'Run the test suite (npm test). ALWAYS run this after making changes to verify nothing broke. If tests fail, read the error and fix the code before continuing.',
    params: {
      path: { type: 'string', optional: true, description: 'Optional path to test file, e.g. "tests/auth.test.js". If omitted, runs all tests.' },
      watch: { type: 'boolean', optional: true, description: 'Run in watch mode. Default: false.' },
    },
    handler: async ({ path, watch = false } = {}) => {
      try {
        let cmd = 'npm test'
        if (path) cmd += ` -- ${String(path)}`
        if (watch) cmd += ' -- --watch'
        const r = await runWorkspaceCommand(cmd, { timeoutMs: 120_000 })
        return ok({
          stdout: truncate(r.stdout, 6000),
          stderr: truncate(r.stderr, 3000),
          exitCode: r.exitCode,
          passed: r.exitCode === 0,
        })
      } catch (e) { return err(e.message) }
    },
  },

  // ── NEW: git ─────────────────────────────────────────────────────────────
  git_status: {
    description: 'Check git status to see what files changed. Useful before committing.',
    params: {},
    handler: async () => {
      try {
        const r = await runWorkspaceCommand('git status --short', { timeoutMs: 30_000 })
        return ok({ status: truncate(r.stdout, 2000), exitCode: r.exitCode })
      } catch (e) { return err(e.message) }
    },
  },

  zip_files: {
    description: 'Create a ZIP archive from files/folders in the current chat workspace. Use this when the user asks to zip/archive/package downloaded files.',
    params: {
      source_path: { type: 'string', optional: true, description: 'File/folder to archive, relative to workspace root. Empty = whole chat workspace.' },
      output_path: { type: 'string', optional: true, description: 'ZIP file path to create, relative to workspace root. Default: workspace.zip.' },
    },
    handler: async ({ source_path = '', output_path = 'workspace.zip', _chatId = '' } = {}) => {
      try {
        const out = String(output_path || 'workspace.zip').toLowerCase().endsWith('.zip') ? String(output_path || 'workspace.zip') : `${output_path}.zip`
        const sourceAbs = safePath(String(source_path || '').replace(/^\/+/, ''))
        const outputAbs = safePath(out.replace(/^\/+/, ''))
        const scan = await scanSecrets({ root: source_path || '' })
        await fsMkdir(path.dirname(outputAbs), { recursive: true })
        const zip = new AdmZip()
        const sourceName = String(source_path || '').trim().replace(/^\/+|\/+$/g, '')
        const rootRel = sourceName ? path.basename(sourceName) : ''
        await addPathToZip(zip, sourceAbs, rootRel, outputAbs)
        const buffer = zip.toBuffer()
        await fsWriteFile(outputAbs, buffer)
        return ok({ file_path: out, path: out, source_path: source_path || '.', bytes: buffer.length, entries: zip.getEntries().length, secret_scan: { ok: scan.ok, high: scan.high, medium: scan.medium, excludedSensitiveFiles: true }, download_url: `/api/workspace/download?path=${encodeURIComponent(out)}${_chatId ? `&chatId=${encodeURIComponent(_chatId)}` : ''}`, visible_in_files: true })
      } catch (e) { return err(e.message) }
    },
  },

  git_clone: {
    description: 'Clone a Git repository into the current chat workspace. If the destination already exists and is a git repo, fetch/pull instead of failing.',
    params: {
      url: { type: 'string', required: true, description: 'Repository URL, e.g. https://github.com/owner/repo.git' },
      dest: { type: 'string', optional: true, description: 'Destination folder name. Default: repo name from URL.' },
    },
    handler: async ({ url, dest } = {}) => {
      if (!url) return err('url is required')
      const target = String(dest || defaultCloneDir(url)).replace(/^\/+|\/+$|\.\./g, '') || defaultCloneDir(url)
      try {
        const qUrl = shQuote(String(url))
        const qTarget = shQuote(target)
        const r = await runWorkspaceCommand(`if [ -d ${qTarget}/.git ]; then cd ${qTarget} && git fetch --all --prune && git pull --ff-only; elif [ -e ${qTarget} ]; then echo "Destination exists but is not a git repository: ${target}" >&2; exit 2; else git clone ${qUrl} ${qTarget}; fi`, { timeoutMs: 120_000 })
        if (r.exitCode !== 0) return err(`git clone failed (${r.exitCode}): ${truncate(r.stderr || r.stdout, 3000)}`)
        return ok({ path: target, containerPath: `${scopedContainerRoot()}/${target}`, stdout: truncate(r.stdout, 4000), stderr: truncate(r.stderr, 1000), updated: /Already up to date|Updating |Fast-forward|From /i.test(r.stdout + r.stderr) })
      } catch (e) { return err(e.message) }
    },
  },

  git_commit: {
    description: 'Stage all changes, commit with a descriptive message, and push to origin. Use this after completing a task to save progress. If push fails, report the error and stop.',
    params: {
      message: { type: 'string', required: true, description: 'Commit message. Be descriptive: "feat: add Telegram bot integration" or "fix: correct auth middleware". Use conventional commits format.' },
    },
    handler: async ({ message } = {}) => {
      if (!message) return err('message is required')
      try {
        const scan = await scanSecrets({ root: '' })
        if (!scan.ok) return err(`Secret scan blocked commit: ${scan.high} high-risk finding(s). Remove secrets or exclude files before committing.`)
        const r1 = await runWorkspaceCommand('git add -A', { timeoutMs: 30_000 })
        if (r1.exitCode !== 0) return ok({ warning: 'git add failed', stderr: r1.stderr })
        const r2 = await runWorkspaceCommand(`git commit -m "${message.replace(/"/g, '\\"')}"`, { timeoutMs: 30_000 })
        if (r2.exitCode !== 0 && !r2.stdout?.includes('nothing to commit')) {
          return ok({ committed: false, stderr: truncate(r2.stderr, 2000) })
        }
        const r3 = await runWorkspaceCommand('git push origin main', { timeoutMs: 60_000 })
        return ok({
          add: r1.stdout,
          commit: r2.stdout,
          push: r3.stdout,
          pushed: r3.exitCode === 0,
          stderr: truncate(r2.stderr + r3.stderr, 3000),
        })
      } catch (e) { return err(e.message) }
    },
  },

  // ── NEW: docker ──────────────────────────────────────────────────────────
  docker_logs: {
    description: 'View recent logs from a Docker container. Useful for debugging crashes. If container is restarting, check the last 20 lines for the error.',
    params: {
      container: { type: 'string', required: true, description: 'Container name, e.g. "browserai" or "agent-sandbox"' },
      tail: { type: 'number', optional: true, description: 'Number of lines to show. Default: 50.' },
    },
    handler: async ({ container, tail = 50 } = {}) => {
      if (!container) return err('container is required')
      try {
        const r = await runSandboxCommand({
          command: `docker logs --tail=${Math.min(500, Math.max(1, Number(tail) || 50))} ${String(container)} 2>&1`,
          timeoutMs: 30_000,
        })
        return ok({ logs: truncate(r.stdout, 8000), exitCode: r.exitCode })
      } catch (e) { return err(e.message) }
    },
  },

  docker_ps: {
    description: 'List running Docker containers with their status, ports, and names.',
    params: {},
    handler: async () => {
      try {
        const r = await runSandboxCommand({ command: 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"', timeoutMs: 30_000 })
        return ok({ containers: truncate(r.stdout, 3000), exitCode: r.exitCode })
      } catch (e) { return err(e.message) }
    },
  },

  // ── NEW: code quality ──────────────────────────────────────────────────────
  verify_code: {
    description: 'Verify syntax of a JavaScript/TypeScript/JSON file. Use this IMMEDIATELY after write_file or edit_file to catch errors before they crash the app.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root, e.g. "server/auth.js" or "package.json"' },
    },
    handler: async ({ path } = {}) => {
      if (!path) return err('path is required')
      try {
        const ext = String(path).toLowerCase().split('.').pop()
        let cmd = ''
        if (['js', 'mjs', 'cjs'].includes(ext)) {
          cmd = `node --check ${shQuote(safePath(path))}`
        } else if (ext === 'json') {
          cmd = `node -e "JSON.parse(require('fs').readFileSync(${JSON.stringify(safePath(path))}, 'utf8'))"`
        } else if (['ts', 'tsx'].includes(ext)) {
          return ok({ path, valid: null, result: 'TypeScript syntax check requires tsc. Run bash: "npx tsc --noEmit" if needed.', skipped: true })
        } else {
          return ok({ path, valid: null, result: 'No built-in syntax checker for this extension. Skipped.', skipped: true })
        }
        const r = await runWorkspaceCommand(cmd, { timeoutMs: 10_000 })
        if (r.exitCode === 0) {
          return ok({ path, valid: true, checker: ext === 'json' ? 'JSON.parse' : 'node --check' })
        }
        return ok({ path, valid: false, error: truncate(r.stderr, 2000), checker: ext === 'json' ? 'JSON.parse' : 'node --check' })
      } catch (e) { return err(e.message) }
    },
  },

  // ── NEW: project context ─────────────────────────────────────────────────
  read_project_rules: {
    description: 'Read AGENTS.md, README.md and package.json from the workspace root. Call this before substantial work to learn project rules, stack and conventions.',
    params: {},
    handler: async () => {
      try {
        const files = ['AGENTS.md', 'README.md', 'package.json']
        const results = {}
        for (const f of files) {
          try {
            const file = await readWorkspaceFile(f)
            results[f] = truncate(file?.text ?? file?.content ?? '', 5000)
          } catch { results[f] = null }
        }
        return ok({ files: results, found: Object.keys(results).filter(k => results[k] !== null) })
      } catch (e) { return err(e.message) }
    },
  },

  generate_image: {
    description: 'Generate an image using Gemini AI (free tier supported via gemini-2.5-flash-image or gemini-3.1-flash-image). Saves to workspace as .png/.jpg/.webp.',
    params: {
      file_path: { type: 'string', required: true, description: 'Path relative to workspace root where the image will be saved, e.g. "images/cat.png". Must end with .png, .jpg, .jpeg, or .webp.' },
      prompt: { type: 'string', required: true, description: 'Image generation prompt in English. Be descriptive and specific about style, lighting, composition, and subject.' },
    },
    handler: async ({ file_path, prompt, _provider }) => {
      if (!file_path || !prompt) return err('file_path and prompt are required')
      const ext = String(file_path).toLowerCase().split('.').pop()
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        return err('file_path must end with .png, .jpg, .jpeg, or .webp')
      }

      let apiKey = ''
      let baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
      if (_provider && isGoogleGenerativeNativeUrl(_provider.baseUrl)) {
        apiKey = _provider.apiKey
        baseUrl = String(_provider.baseUrl).replace(/\/+$/, '')
      } else if (process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY
      } else {
        return err('No Gemini API key available.')
      }

      const imageModel = _provider?.model?.includes('gemini-3.1') ? 'gemini-3.1-flash-image' :
                         _provider?.model?.includes('gemini-3') ? 'gemini-3.1-flash-image' :
                         'gemini-2.5-flash-image'

      const proxyUrl = process.env.CF_PROXY_URL || ''
      const proxySecret = process.env.CF_PROXY_SECRET || ''

      try {
        const targetUrl = `${baseUrl}/models/${imageModel}:generateContent?key=${encodeURIComponent(apiKey)}`
        const body = {
          contents: [{
            role: 'user',
            parts: [{ text: `Generate an image: ${String(prompt)}` }]
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: 0.9
          }
        }

        let r
        if (proxyUrl) {
          r = await fetchViaProxy({
            url: targetUrl, method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body, proxyUrl, proxySecret, timeoutMs: 120_000,
          })
        } else {
          r = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          })
        }

        const raw = await r.text()
        if (!r.ok) {
          return err(`Image generation failed: HTTP ${r.status} ${raw.slice(0, 300)}`)
        }

        const data = safeJsonParse(raw)
        if (!data) return err(`Image generation returned non-JSON: ${raw.slice(0, 300)}`)

        const parts = data?.candidates?.[0]?.content?.parts || []
        const imagePart = parts.find(p => p.inlineData || p.inline_data)
        const textPart = parts.find(p => p.text)

        if (!imagePart) {
          return err(`No image generated. Response: ${textPart?.text || JSON.stringify(data).slice(0, 300)}`)
        }

        const inlineData = imagePart.inlineData || imagePart.inline_data
        const mimeType = inlineData?.mimeType || inlineData?.mime_type || 'image/png'
        const base64Data = inlineData?.data || ''

        if (!base64Data) {
          return err(`Image data is empty.`)
        }

        const imageBuffer = Buffer.from(base64Data, 'base64')
        const outExt = mimeType === 'image/webp' ? 'webp' : mimeType === 'image/jpeg' ? 'jpg' : 'png'
        const finalPath = String(file_path).replace(/\.[^.]+$/, `.${outExt}`)

        await ensureParentDirs(finalPath)
        const pathParts = String(finalPath).split('/').filter(Boolean)
        const name = pathParts.pop()
        const parent = pathParts.join('/')
        const outFull = safePath(finalPath)
        await fsMkdir(path.dirname(outFull), { recursive: true })
        await fsWriteFile(outFull, imageBuffer)

        return ok({ file_path: finalPath, mimeType, bytes: imageBuffer.length, prompt: String(prompt) })
      } catch (e) {
        return err(`Image generation error: ${e.message}`)
      }
    },
  },

  edit_image: {
    description: 'Edit an image using Gemini AI (free tier supported). Provide original image and edit prompt. Saves edited image to workspace.',
    params: {
      file_path: { type: 'string', required: true, description: 'Path to the original image in the workspace, e.g. "images/cat.png".' },
      prompt: { type: 'string', required: true, description: 'Edit instruction in English, e.g. "Add a red hat" or "Change background to sunset".' },
      output_path: { type: 'string', required: true, description: 'Where to save the edited image. Must end with .png, .jpg, .jpeg, or .webp.' },
    },
    handler: async ({ file_path, prompt, output_path, _provider }) => {
      if (!file_path || !prompt || !output_path) return err('file_path, prompt, and output_path are required')
      const outExt = String(output_path).toLowerCase().split('.').pop()
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(outExt)) return err('output_path must end with .png, .jpg, .jpeg, or .webp')

      let apiKey = ''
      let baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
      if (_provider && isGoogleGenerativeNativeUrl(_provider.baseUrl)) {
        apiKey = _provider.apiKey
        baseUrl = String(_provider.baseUrl).replace(/\/+$/, '')
      } else if (process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY
      } else {
        return err('No Gemini API key available.')
      }

      const imageModel = _provider?.model?.includes('gemini-3.1') ? 'gemini-3.1-flash-image' :
                         _provider?.model?.includes('gemini-3') ? 'gemini-3.1-flash-image' :
                         'gemini-2.5-flash-image'

      const proxyUrl = process.env.CF_PROXY_URL || ''
      const proxySecret = process.env.CF_PROXY_SECRET || ''

      try {
        const imagePath = safePath(String(file_path).replace(/^\/+/, ''))
        const imageBuffer = await fsReadFile(imagePath)
        const base64Image = imageBuffer.toString('base64')
        const mimeType = String(file_path).toLowerCase().endsWith('.png') ? 'image/png' :
                         String(file_path).toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg'

        const targetUrl = `${baseUrl}/models/${imageModel}:generateContent?key=${encodeURIComponent(apiKey)}`
        const body = {
          contents: [{
            role: 'user',
            parts: [
              { text: `Edit this image: ${String(prompt)}` },
              { inlineData: { mimeType, data: base64Image } }
            ]
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: 0.9
          }
        }

        let r
        if (proxyUrl) {
          r = await fetchViaProxy({
            url: targetUrl, method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body, proxyUrl, proxySecret, timeoutMs: 120_000,
          })
        } else {
          r = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          })
        }

        const raw = await r.text()
        if (!r.ok) {
          return err(`Image edit failed: HTTP ${r.status} ${raw.slice(0, 300)}`)
        }

        const data = safeJsonParse(raw)
        if (!data) return err(`Image edit returned non-JSON: ${raw.slice(0, 300)}`)

        const parts = data?.candidates?.[0]?.content?.parts || []
        const imagePart = parts.find(p => p.inlineData || p.inline_data)
        const textPart = parts.find(p => p.text)

        if (!imagePart) {
          return err(`No edited image returned. Response: ${textPart?.text || JSON.stringify(data).slice(0, 300)}`)
        }

        const inlineData = imagePart.inlineData || imagePart.inline_data
        const outMimeType = inlineData?.mimeType || inlineData?.mime_type || 'image/png'
        const base64Data = inlineData?.data || ''

        if (!base64Data) {
          return err(`Edited image data is empty.`)
        }

        const outBuffer = Buffer.from(base64Data, 'base64')
        const outExt2 = outMimeType === 'image/webp' ? 'webp' : outMimeType === 'image/jpeg' ? 'jpg' : 'png'
        const finalPath = String(output_path).replace(/\.[^.]+$/, `.${outExt2}`)

        await ensureParentDirs(finalPath)
        const pathParts = String(finalPath).split('/').filter(Boolean)
        const name = pathParts.pop()
        const parent = pathParts.join('/')
        const outFull = safePath(finalPath)
        await fsMkdir(path.dirname(outFull), { recursive: true })
        await fsWriteFile(outFull, outBuffer)

        return ok({ file_path: finalPath, mimeType: outMimeType, bytes: outBuffer.length, prompt: String(prompt) })
      } catch (e) {
        return err(`Image edit error: ${e.message}`)
      }
    },
  },

  generate_video: {
    description: 'Generate a short AI video using Luma Dream Machine. Requires LUMA_API_KEY in environment. Saves as .mp4.',
    params: {
      file_path: { type: 'string', required: true, description: 'Output path, e.g. "videos/clip.mp4". Must end with .mp4.' },
      prompt: { type: 'string', required: true, description: 'Video description in English. Be detailed about motion, camera, scene.' },
    },
    handler: async ({ file_path, prompt }) => {
      if (!file_path || !prompt) return err('file_path and prompt are required')
      if (!String(file_path).toLowerCase().endsWith('.mp4')) return err('file_path must end with .mp4')
      const lumaKey = process.env.LUMA_API_KEY
      if (!lumaKey) return err('LUMA_API_KEY not set. Get a free key at https://lumalabs.ai/api')
      try {
        const createRes = await fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${lumaKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: String(prompt), aspect_ratio: '16:9' }),
          signal: AbortSignal.timeout(120_000),
        })
        const createData = safeJsonParse(await createRes.text())
        if (!createRes.ok || !createData?.id) return err(`Luma create failed: ${createRes.status} ${JSON.stringify(createData).slice(0, 300)}`)
        const genId = createData.id
        let completed = false, videoUrl = '', attempts = 0
        while (!completed && attempts < 60) {
          await new Promise(r => setTimeout(r, 5000))
          attempts++
          const pollRes = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${genId}`, {
            headers: { 'Authorization': `Bearer ${lumaKey}` },
            signal: AbortSignal.timeout(30_000),
          })
          const pollData = safeJsonParse(await pollRes.text())
          if (pollData?.state === 'completed') { completed = true; videoUrl = pollData?.assets?.video || '' }
          else if (pollData?.state === 'failed') return err(`Luma generation failed: ${pollData?.failure_reason || 'unknown'}`)
        }
        if (!videoUrl) return err('Luma generation timed out after 5 minutes')
        const videoRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) })
        if (!videoRes.ok) return err(`Failed to download video: ${videoRes.status}`)
        const videoBuffer = Buffer.from(await videoRes.arrayBuffer())
        const outFull = safePath(String(file_path).replace(/^\/+/, ''))
        await fsMkdir(path.dirname(outFull), { recursive: true })
        await fsWriteFile(outFull, videoBuffer)
        return ok({ file_path, bytes: videoBuffer.length, prompt: String(prompt), luma_id: genId })
      } catch (e) { return err(`Video generation error: ${e.message}`) }
    },
  },

  analyze_image: {
    description: 'Analyze and describe an image using Gemini Vision AI. Returns a detailed text description of the image content.',
    params: {
      file_path: { type: 'string', required: true, description: 'Path to the image in the workspace, e.g. "screenshots/page.png", "images/photo.jpg".' },
      question: { type: 'string', optional: true, description: 'Specific question about the image. Default: "Describe this image in detail."' },
    },
    handler: async ({ file_path, question = 'Describe this image in detail.', _provider }) => {
      if (!file_path) return err('file_path is required')
      let apiKey = '', baseUrl = 'https://generativelanguage.googleapis.com/v1beta', model = 'gemini-2.5-flash'
      if (_provider && isGoogleGenerativeNativeUrl(_provider.baseUrl)) {
        apiKey = _provider.apiKey; baseUrl = String(_provider.baseUrl).replace(/\/+$/, ''); model = _provider.model || 'gemini-2.5-flash'
      } else if (process.env.GEMINI_API_KEY) { apiKey = process.env.GEMINI_API_KEY }
      else { return err('No Gemini API key available.') }
      try {
        const imagePath = safePath(String(file_path).replace(/^\/+/, ''))
        const imageBuffer = await fsReadFile(imagePath)
        const base64Image = imageBuffer.toString('base64')
        const mimeType = String(file_path).toLowerCase().endsWith('.png') ? 'image/png' :
                         String(file_path).toLowerCase().endsWith('.webp') ? 'image/webp' :
                         String(file_path).toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/jpeg'
        const targetUrl = `${baseUrl}/models/${model.replace(/^models\//, '')}:generateContent?key=${encodeURIComponent(apiKey)}`
        const body = {
          contents: [{ role: 'user', parts: [{ text: String(question) }, { inline_data: { mime_type: mimeType, data: base64Image } }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
        }
        const proxyUrl = process.env.CF_PROXY_URL || ''
        const proxySecret = process.env.CF_PROXY_SECRET || ''
        let r
        if (proxyUrl) {
          r = await fetchViaProxy({ url: targetUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body, proxyUrl, proxySecret, timeoutMs: 120_000 })
        } else {
          r = await fetch(targetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
        }
        const raw = await r.text()
        if (!r.ok) return err(`Image analysis failed: HTTP ${r.status} ${raw.slice(0, 300)}`)
        const data = safeJsonParse(raw)
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
        if (!text) return err(`No analysis returned: ${raw.slice(0, 300)}`)
        return ok({ description: text, file_path })
      } catch (e) { return err(`Image analysis error: ${e.message}`) }
    },
  },

  text_to_speech: {
    description: 'Convert text to speech using ElevenLabs AI. Saves as .mp3 or .wav. Requires ELEVENLABS_API_KEY in environment.',
    params: {
      file_path: { type: 'string', required: true, description: 'Output path, e.g. "audio/greeting.mp3". Must end with .mp3 or .wav.' },
      text: { type: 'string', required: true, description: 'Text to speak. Supports Russian and other languages.' },
      voice_id: { type: 'string', optional: true, description: 'ElevenLabs voice ID. Default: "21m00Tcm4TlvDq8ikWAM" (Rachel).' },
    },
    handler: async ({ file_path, text, voice_id = '21m00Tcm4TlvDq8ikWAM' }) => {
      if (!file_path || !text) return err('file_path and text are required')
      const ext = String(file_path).toLowerCase().split('.').pop()
      if (!['mp3', 'wav'].includes(ext)) return err('file_path must end with .mp3 or .wav')
      const key = process.env.ELEVENLABS_API_KEY
      if (!key) return err('ELEVENLABS_API_KEY not set. Get a free key at https://elevenlabs.io')
      try {
        const targetUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}`
        const body = { text: String(text), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.5 } }
        const r = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        })
        if (!r.ok) { const raw = await r.text(); return err(`TTS failed: HTTP ${r.status} ${raw.slice(0, 300)}`) }
        const audioBuffer = Buffer.from(await r.arrayBuffer())
        const outFull = safePath(String(file_path).replace(/^\/+/, ''))
        await fsMkdir(path.dirname(outFull), { recursive: true })
        await fsWriteFile(outFull, audioBuffer)
        return ok({ file_path, bytes: audioBuffer.length, voice_id, text: String(text).slice(0, 200) })
      } catch (e) { return err(`TTS error: ${e.message}`) }
    },
  },

  transcribe_audio: {
    description: 'Transcribe an audio file to text using Gemini AI. Supports mp3, wav, ogg, m4a, flac. Returns the transcribed text.',
    params: {
      file_path: { type: 'string', required: true, description: 'Path to the audio file, e.g. "audio/recording.mp3", "voice.ogg", "call.wav".' },
      language: { type: 'string', optional: true, description: 'Language hint, e.g. "ru", "en". Auto-detect if omitted.' },
    },
    handler: async ({ file_path, language, _provider }) => {
      if (!file_path) return err('file_path is required')
      let apiKey = '', baseUrl = 'https://generativelanguage.googleapis.com/v1beta', model = 'gemini-2.5-flash'
      if (_provider && isGoogleGenerativeNativeUrl(_provider.baseUrl)) {
        apiKey = _provider.apiKey; baseUrl = String(_provider.baseUrl).replace(/\/+$/, ''); model = _provider.model || 'gemini-2.5-flash'
      } else if (process.env.GEMINI_API_KEY) { apiKey = process.env.GEMINI_API_KEY }
      else { return err('No Gemini API key available.') }
      try {
        const audioPath = safePath(String(file_path).replace(/^\/+/, ''))
        const audioBuffer = await fsReadFile(audioPath)
        const base64Audio = audioBuffer.toString('base64')
        const ext = String(file_path).toLowerCase().split('.').pop()
        const mimeType = ext === 'mp3' ? 'audio/mp3' : ext === 'ogg' ? 'audio/ogg' : ext === 'm4a' ? 'audio/mp4' : ext === 'flac' ? 'audio/flac' : 'audio/wav'
        const targetUrl = `${baseUrl}/models/${model.replace(/^models\//, '')}:generateContent?key=${encodeURIComponent(apiKey)}`
        const prompt = language ? `Transcribe this audio in ${language}. Return ONLY the transcription text, no explanations.` : 'Transcribe this audio. Return ONLY the transcription text, no explanations.'
        const body = {
          contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Audio } }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
        }
        const proxyUrl = process.env.CF_PROXY_URL || ''
        const proxySecret = process.env.CF_PROXY_SECRET || ''
        let r
        if (proxyUrl) {
          r = await fetchViaProxy({ url: targetUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body, proxyUrl, proxySecret, timeoutMs: 180_000 })
        } else {
          r = await fetch(targetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
        }
        const raw = await r.text()
        if (!r.ok) return err(`Transcription failed: HTTP ${r.status} ${raw.slice(0, 300)}`)
        const data = safeJsonParse(raw)
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
        if (!text) return err(`No transcription returned: ${raw.slice(0, 300)}`)
        return ok({ transcription: text, file_path, language })
      } catch (e) { return err(`Transcription error: ${e.message}`) }
    },
  },


  // ── Browser tools (headless Playwright) ───────────────────────────────────
  browser_open: {
    description: 'Open a URL in a headless browser and return page summary + screenshot. Use for scraping or verifying deployed pages.',
    params: {
      url: { type: 'string', required: true, description: 'Full URL starting with http:// or https://' },
      waitMs: { type: 'number', optional: true, description: 'Wait after page load (ms), default 1500.' },
      screenshot: { type: 'boolean', optional: true, description: 'Take screenshot, default true.' },
    },
    handler: async ({ url, waitMs = 1500, screenshot = true }) => {
      try { return ok(await browserOpen({ url, waitMs, screenshot })) } catch (e) { return err(e.message) }
    },
  },
  browser_screenshot: {
    description: 'Take a screenshot of an existing browser session.',
    params: {
      sessionId: { type: 'string', required: true, description: 'Session ID returned by browser_open.' },
      path: { type: 'string', optional: true, description: 'Optional workspace path to save the screenshot.' },
    },
    handler: async ({ sessionId, path: relPath = '' }) => {
      try { return ok(await browserScreenshot({ sessionId, path: relPath })) } catch (e) { return err(e.message) }
    },
  },
  browser_click: {
    description: 'Click an element in the browser (by CSS selector or text).',
    params: {
      sessionId: { type: 'string', required: true, description: 'Session ID.' },
      selector: { type: 'string', optional: true, description: 'CSS selector.' },
      text: { type: 'string', optional: true, description: 'Text to find and click.' },
      waitMs: { type: 'number', optional: true, description: 'Wait after click (ms).' },
    },
    handler: async ({ sessionId, selector = '', text = '', waitMs = 1000 }) => {
      try { return ok(await browserClick({ sessionId, selector, text, waitMs })) } catch (e) { return err(e.message) }
    },
  },
  browser_type: {
    description: 'Type text into a form field in the browser.',
    params: {
      sessionId: { type: 'string', required: true, description: 'Session ID.' },
      selector: { type: 'string', required: true, description: 'CSS selector of input.' },
      text: { type: 'string', required: true, description: 'Text to type.' },
      pressEnter: { type: 'boolean', optional: true, description: 'Press Enter after typing.' },
      waitMs: { type: 'number', optional: true, description: 'Wait after type (ms).' },
    },
    handler: async ({ sessionId, selector, text, pressEnter = false, waitMs = 1000 }) => {
      try { return ok(await browserType({ sessionId, selector, text, pressEnter, waitMs })) } catch (e) { return err(e.message) }
    },
  },
  browser_close: {
    description: 'Close a browser session.',
    params: {
      sessionId: { type: 'string', required: true, description: 'Session ID.' },
    },
    handler: async ({ sessionId }) => {
      try { return ok(await browserClose({ sessionId })) } catch (e) { return err(e.message) }
    },
  },

  // ── Computer Use tools (VNC desktop) ──────────────────────────────────────
  computer_screenshot: {
    description: 'Take a screenshot of the virtual X11 desktop (computer-sandbox).',
    params: {},
    handler: async () => {
      try { return ok(await computerScreenshot()) } catch (e) { return err(e.message) }
    },
  },
  computer_click: {
    description: 'Click at coordinates (x, y) on the virtual desktop.',
    params: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
      button: { type: 'string', optional: true, description: 'left|middle|right, default left.' },
    },
    handler: async ({ x, y, button = 'left' }) => {
      try { return ok(await computerClick({ x, y, button })) } catch (e) { return err(e.message) }
    },
  },
  computer_type: {
    description: 'Type text on the virtual desktop.',
    params: { text: { type: 'string', required: true } },
    handler: async ({ text }) => {
      try { return ok(await computerType({ text })) } catch (e) { return err(e.message) }
    },
  },
  computer_open_app: {
    description: 'Open an app (firefox, terminal) on the virtual desktop.',
    params: {
      name: { type: 'string', required: true, description: 'firefox or terminal.' },
      url: { type: 'string', optional: true, description: 'URL for firefox.' },
    },
    handler: async ({ name, url }) => {
      try { return ok(await computerOpenApp({ name, url })) } catch (e) { return err(e.message) }
    },
  },
  computer_status: {
    description: 'Check virtual desktop status.',
    params: {},
    handler: async () => {
      try { return ok(await computerStatus()) } catch (e) { return err(e.message) }
    },
  },

  // ── Operator Mode tools ───────────────────────────────────────────────────
  operator_status: {
    description: 'Get BrowserAI Operator Mode control/status: projects, recent missions, live ops health/docker/sync.',
    params: {},
    handler: async ({ _userId } = {}) => {
      try {
        const { getOperatorStatus } = await import('./operatorMode.js')
        return ok(await getOperatorStatus({ userId: _userId || '' }))
      } catch (e) { return err(e.message) }
    },
  },
  operator_project_profile: {
    description: 'List registered Operator Mode projects and production paths. Use before broad development/operator tasks.',
    params: {},
    handler: async ({ _userId } = {}) => {
      try {
        const { listOperatorProjects } = await import('./operatorMode.js')
        return ok({ projects: listOperatorProjects({ userId: _userId || '' }) })
      } catch (e) { return err(e.message) }
    },
  },
  operator_start_mission: {
    description: 'Start an Operator Mode mission. Use for broad end-to-end tasks: universal_dev_task, code_task, fix_tests, full_diagnostic, fix_deploy, safe_deploy, self_heal_restart. Production-write missions require confirm=true after user approval.',
    params: {
      type: { type: 'string', optional: true, description: 'Mission type. Default: universal_dev_task.' },
      goal: { type: 'string', required: true, description: 'User goal / task description.' },
      project_id: { type: 'string', optional: true, description: 'Operator project id. Default: browserai.' },
      confirm: { type: 'boolean', optional: true, description: 'Set true only after explicit user approval for production-write missions.' },
    },
    handler: async ({ type = 'universal_dev_task', goal = '', project_id = 'browserai', confirm = false, _userId } = {}) => {
      try {
        const { startOperatorMission } = await import('./operatorMode.js')
        return ok(startOperatorMission({ userId: _userId || '', projectId: project_id || 'browserai', type, goal, confirm }))
      } catch (e) { return err(e.message) }
    },
  },
  operator_list_missions: {
    description: 'List recent Operator Mode missions for this user.',
    params: { limit: { type: 'number', optional: true, description: 'Max missions, default 10.' } },
    handler: async ({ limit = 10, _userId } = {}) => {
      try {
        const { listOperatorMissions } = await import('./operatorMode.js')
        return ok({ missions: listOperatorMissions({ userId: _userId || '', limit }) })
      } catch (e) { return err(e.message) }
    },
  },
  operator_get_mission: {
    description: 'Get one Operator Mode mission by id, including linked workflow/job status.',
    params: { id: { type: 'string', required: true, description: 'Operator mission id.' } },
    handler: async ({ id } = {}) => {
      try {
        const { getOperatorMission } = await import('./operatorMode.js')
        const mission = getOperatorMission(id)
        return mission ? ok({ mission }) : err('mission not found')
      } catch (e) { return err(e.message) }
    },
  },

  operator_finalize_code_task: {
    description: 'Finalize a verified Operator Code Task: rerun deterministic verification, secret scan, git commit, push branch and optionally create a GitHub PR. Requires GitHub token for push/PR.',
    params: {
      id: { type: 'string', required: true, description: 'Operator code task id.' },
      commit_message: { type: 'string', optional: true, description: 'Commit message.' },
      push: { type: 'boolean', optional: true, description: 'Push branch to GitHub. Default true.' },
      create_pr: { type: 'boolean', optional: true, description: 'Create GitHub PR. Default true.' },
      pr_title: { type: 'string', optional: true, description: 'Optional PR title.' },
      pr_body: { type: 'string', optional: true, description: 'Optional PR body.' },
    },
    handler: async ({ id, commit_message = '', push = true, create_pr = true, pr_title = '', pr_body = '' } = {}) => {
      try {
        const { finalizeOperatorCodeTask } = await import('./operatorCode.js')
        return ok(await finalizeOperatorCodeTask({ taskId: id, commitMessage: commit_message, push, createPr: create_pr, prTitle: pr_title, prBody: pr_body }))
      } catch (e) { return err(e.message) }
    },
  },

  operator_wait_code_task_ci: {
    description: 'Wait for GitHub Actions CI for an Operator Code Task branch/PR. On failure, fetches summarized workflow logs and creates an incident.',
    params: {
      id: { type: 'string', required: true, description: 'Operator code task id.' },
      timeout_sec: { type: 'number', optional: true, description: 'Max wait seconds. Default 900.' },
      interval_sec: { type: 'number', optional: true, description: 'Polling interval seconds. Default 15.' },
    },
    handler: async ({ id, timeout_sec = 900, interval_sec = 15 } = {}) => {
      try {
        const { waitOperatorCodeTaskCi } = await import('./operatorCode.js')
        return ok(await waitOperatorCodeTaskCi({ taskId: id, timeoutSec: timeout_sec, intervalSec: interval_sec }))
      } catch (e) { return err(e.message) }
    },
  },

  operator_auto_fix_code_task_ci: {
    description: 'Start a background auto-fix loop for a Code Operator task whose PR/branch CI failed. It uses CI logs, runs another code agent pass on the same branch, verifies, commits, pushes, and waits CI again up to max_attempts.',
    params: {
      id: { type: 'string', required: true, description: 'Operator code task id.' },
      max_attempts: { type: 'number', optional: true, description: 'Max auto-fix attempts. Default 2.' },
    },
    handler: async ({ id, max_attempts = 2 } = {}) => {
      try {
        const { startOperatorCodeCiAutoFix } = await import('./operatorCode.js')
        return ok(startOperatorCodeCiAutoFix({ taskId: id, maxAttempts: max_attempts }))
      } catch (e) { return err(e.message) }
    },
  },

  operator_merge_code_task_pr: {
    description: 'Merge a Code Operator PR after CI is green. Optionally starts safe production deploy after merge. Requires explicit user approval for deploy=true.',
    params: {
      id: { type: 'string', required: true, description: 'Operator code task id.' },
      merge_method: { type: 'string', optional: true, description: 'merge, squash, or rebase. Default squash.' },
      deploy: { type: 'boolean', optional: true, description: 'Start safe deploy after merge. Default false.' },
      confirm_deploy: { type: 'boolean', optional: true, description: 'Must be true after explicit approval if deploy=true.' },
    },
    handler: async ({ id, merge_method = 'squash', deploy = false, confirm_deploy = false } = {}) => {
      try {
        const { mergeOperatorCodeTaskPr } = await import('./operatorCode.js')
        return ok(await mergeOperatorCodeTaskPr({ taskId: id, mergeMethod: merge_method, deploy, confirmDeploy: confirm_deploy }))
      } catch (e) { return err(e.message) }
    },
  },

  // ── Ops tools ─────────────────────────────────────────────────────────────
  ops_list_services: {
    description: 'List available deployment / ops services (GitHub, Timeweb, etc).',
    params: {},
    handler: async () => {
      try { return ok(listOpsServices()) } catch (e) { return err(e.message) }
    },
  },
  ops_run_action: {
    description: 'Run an ops action (build, deploy, restart). Potentially destructive — requires confirmation.',
    params: {
      service: { type: 'string', required: true, description: 'Service id, e.g. github, timeweb.' },
      action: { type: 'string', required: true, description: 'Action name.' },
      params: { type: 'object', optional: true, description: 'Action parameters.' },
      confirm: { type: 'boolean', optional: true, description: 'Set true after user confirmation.' },
    },
    handler: async ({ service, action, params = {}, confirm = false }) => {
      try { return ok(await runOpsAction({ service, action, params, confirm })) } catch (e) { return err(e.message) }
    },
  },
}

// Minimal tool set for low-complexity runs (must match agentLoop.js lite filter)
export const LITE_TOOL_NAMES = [
  'list_files', 'read_file', 'write_file', 'edit_file', 'search_files',
  'bash', 'web_search', 'web_fetch', 'ask_user',
  'delete_file', 'verify_code', 'read_project_rules', 'generate_image',
  'edit_image', 'analyze_image', 'transcribe_audio',
]

export function renderToolsForPrompt(extraTools = null, { lite = false, toolNames = null } = {}) {
  let combined = extraTools && typeof extraTools === 'object' ? { ...TOOLS, ...extraTools } : TOOLS
  if (Array.isArray(toolNames) && toolNames.length > 0) {
    const allowed = new Set(toolNames)
    combined = Object.fromEntries(Object.entries(combined).filter(([name]) => allowed.has(name)))
  } else if (lite) {
    const allowed = new Set(LITE_TOOL_NAMES)
    combined = Object.fromEntries(Object.entries(combined).filter(([name]) => allowed.has(name)))
  }

  const lines = []
  for (const [name, def] of Object.entries(combined)) {
    lines.push(`### ${name}`)
    lines.push(def.description)
    const params = Object.entries(def.params || {})
    if (params.length) {
      lines.push('Parameters:')
      for (const [p, meta] of params) {
        const flag = meta.required ? '(required)' : '(optional)'
        lines.push(`  - "${p}" ${flag} — ${meta.type}: ${meta.description || ''}`)
      }
    } else {
      lines.push('No parameters.')
    }
    lines.push('')
  }
  return lines.join('\n')
}

export async function invokeTool(name, args = {}, { signal, onStdout, onStderr, userId, chatId, extraTools } = {}) {
  const tool = TOOLS[name] || (extraTools && extraTools[name])
  if (!tool) return err(`Unknown tool: ${name}`)
  if (typeof tool.handler !== 'function') return err(`Tool ${name} has no handler`)
  const enrichedArgs = { ...(args || {}) }
  if (userId) enrichedArgs._userId = userId
  if (chatId) enrichedArgs._chatId = chatId
  try {
    if (signal?.aborted) return err('cancelled')
    return await tool.handler(enrichedArgs)
  } catch (e) {
    if (signal?.aborted) return err('cancelled')
    return err(e?.message || String(e))
  }
}
