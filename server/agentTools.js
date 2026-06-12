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
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'
import { runSandboxCommand } from './agentSandbox.js'
import { upsertFact, forgetFact, listFacts } from './userMemory.js'
import { addDocument, deleteDocument, listDocuments, searchKnowledge } from './knowledgeBase.js'
import { fetchViaProxy, isGoogleGenerativeNativeUrl } from './llmClient.js'
import { writeFile as fsWriteFile, readFile as fsReadFile, mkdir as fsMkdir } from 'node:fs/promises'
import path from 'node:path'

function safeJsonParse(text) { try { return JSON.parse(text) } catch { return null } }

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
        const r = await runSandboxCommand({
          command: String(command),
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
        const r = await runSandboxCommand({
          command: `cd /workspace && npm install ${flag} ${String(pkg)}`,
          timeoutMs: 120_000,
        })
        return ok({
          stdout: truncate(r.stdout, 6000),
          stderr: truncate(r.stderr, 3000),
          exitCode: r.exitCode,
          installed: pkg,
        })
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
        let cmd = 'cd /workspace && npm test'
        if (path) cmd += ` -- ${String(path)}`
        if (watch) cmd += ' -- --watch'
        const r = await runSandboxCommand({ command: cmd, timeoutMs: 120_000 })
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
        const r = await runSandboxCommand({ command: 'cd /workspace && git status --short', timeoutMs: 30_000 })
        return ok({ status: truncate(r.stdout, 2000), exitCode: r.exitCode })
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
        const r1 = await runSandboxCommand({ command: 'cd /workspace && git add -A', timeoutMs: 30_000 })
        if (r1.exitCode !== 0) return ok({ warning: 'git add failed', stderr: r1.stderr })
        const r2 = await runSandboxCommand({ command: `cd /workspace && git commit -m "${message.replace(/"/g, '\\"')}"`, timeoutMs: 30_000 })
        if (r2.exitCode !== 0 && !r2.stdout?.includes('nothing to commit')) {
          return ok({ committed: false, stderr: truncate(r2.stderr, 2000) })
        }
        const r3 = await runSandboxCommand({ command: 'cd /workspace && git push origin main', timeoutMs: 60_000 })
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
          cmd = `node --check /workspace/${path}`
        } else if (ext === 'json') {
          cmd = `node -e "JSON.parse(require('fs').readFileSync('/workspace/${path}', 'utf8'))"`
        } else if (['ts', 'tsx'].includes(ext)) {
          return ok({ path, valid: null, result: 'TypeScript syntax check requires tsc. Run bash: "npx tsc --noEmit" if needed.', skipped: true })
        } else {
          return ok({ path, valid: null, result: 'No built-in syntax checker for this extension. Skipped.', skipped: true })
        }
        const r = await runSandboxCommand({ command: cmd, timeoutMs: 10_000 })
        if (r.exitCode === 0) {
          return ok({ path, valid: true, checker: ext === 'json' ? 'JSON.parse' : 'node --check' })
        }
        return ok({ path, valid: false, error: truncate(r.stderr, 2000), checker: ext === 'json' ? 'JSON.parse' : 'node --check' })
      } catch (e) { return err(e.message) }
    },
  },

  // ── NEW: project context ─────────────────────────────────────────────────
  read_project_rules: {
    description: 'Read AGENTS.md and PROJECT_CONTEXT.md from the workspace root. Call this BEFORE starting work on a new task to learn the project rules, stack, and conventions.',
    params: {},
    handler: async () => {
      try {
        const files = ['AGENTS.md', 'PROJECT_CONTEXT.md', 'README.md', 'package.json']
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
    description: 'Generate an image using AI (Google Gemini / Imagen) and save it to the workspace. Requires an active Gemini API key with image generation access (paid plan). Free tier keys do NOT support image generation.',
    params: {
      file_path: { type: 'string', required: true, description: 'Path relative to workspace root where the image will be saved, e.g. "assets/image.png" or "images/cat.jpg". Must end with .png, .jpg, .jpeg, or .webp.' },
      prompt: { type: 'string', required: true, description: 'Detailed image generation prompt in English. Be descriptive and specific about style, lighting, composition, and subject.' },
    },
    handler: async ({ file_path, prompt, _provider }) => {
      if (!file_path || !prompt) return err('file_path and prompt are required')
      const ext = String(file_path).toLowerCase().split('.').pop()
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        return err('file_path must end with .png, .jpg, .jpeg, or .webp')
      }

      // Determine API key and base URL
      let apiKey = ''
      let baseUrl = 'https://generativelanguage.googleapis.com/v1beta'

      if (_provider && isGoogleGenerativeNativeUrl(_provider.baseUrl)) {
        apiKey = _provider.apiKey
        baseUrl = String(_provider.baseUrl).replace(/\/+$/, '')
      } else if (process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY
      } else {
        return err('No Gemini API key available. Add a Gemini provider key or set GEMINI_API_KEY in .env.')
      }

      const proxyUrl = process.env.CF_PROXY_URL || ''
      const proxySecret = process.env.CF_PROXY_SECRET || ''

      try {
        // Try available Imagen models (free tier returns 400 "paid plans only")
        const imagenModels = ['imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001', 'imagen-3.0-generate-002']
        let lastError = ''

        for (const model of imagenModels) {
          const targetUrl = `${baseUrl}/models/${model}:predict?key=${encodeURIComponent(apiKey)}`
          const body = {
            instances: [{ prompt: String(prompt) }],
            parameters: {
              sampleCount: 1,
              aspectRatio: '1:1',
              outputMimeType: ext === 'webp' ? 'image/webp' : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'),
            },
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
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
            })
          }

          const raw = await r.text()
          if (!r.ok) {
            lastError = raw.slice(0, 300)
            if (raw.includes('paid plans') || raw.includes('quota') || raw.includes('billing') || raw.includes('limit')) {
              // Free tier / billing issue — try next model or report clearly
              continue
            }
            return err(`Image generation failed: HTTP ${r.status} ${raw.slice(0, 300)}`)
          }

          const data = safeJsonParse(raw)
          if (!data) return err(`Image generation returned non-JSON: ${raw.slice(0, 300)}`)

          const prediction = data?.predictions?.[0]
          if (!prediction?.bytesBase64Encoded) {
            return err(`No image generated: ${JSON.stringify(data).slice(0, 300)}`)
          }

          const imageBuffer = Buffer.from(prediction.bytesBase64Encoded, 'base64')
          const mimeType = prediction.mimeType || (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png')

          await ensureParentDirs(file_path)
          const parts = String(file_path).split('/').filter(Boolean)
          const name = parts.pop()
          const parent = parts.join('/')
          const parentFull = parent ? `/workspace/${parent}` : '/workspace'
          await fsMkdir(parentFull, { recursive: true })
          await fsWriteFile(`/workspace/${file_path}`, imageBuffer)

          return ok({ file_path, mimeType, bytes: imageBuffer.length, prompt: String(prompt) })
        }

        // All models failed — likely free tier
        return err(`Image generation not available on this API key. ${lastError.includes('paid plans') ? 'Gemini free tier does not support image generation. Upgrade to a paid Google Cloud plan, or use a different provider (e.g. OpenAI DALL-E with OPENAI_API_KEY).' : 'Last error: ' + lastError}`)
      } catch (e) {
        return err(`Image generation error: ${e.message}`)
      }
    },
  },
}

// Minimal tool set for low-complexity runs (must match agentLoop.js lite filter)
export const LITE_TOOL_NAMES = [
  'list_files', 'read_file', 'write_file', 'edit_file', 'search_files',
  'bash', 'web_search', 'web_fetch', 'ask_user',
  'delete_file', 'verify_code', 'read_project_rules', 'generate_image',
  'edit_image', 'generate_video', 'analyze_image', 'text_to_speech', 'transcribe_audio',
]

export function renderToolsForPrompt() {
  const lines = []
  for (const [name, def] of Object.entries(TOOLS)) {
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
