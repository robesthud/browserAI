/**
 * agentTools.js
 *
 * Registry of tools the DeepSeek agent loop can invoke. Each tool is:
 *   - declarative: name + description + JSON-schema-ish params
 *   - imperative: an async handler that does the work and returns
 *     {ok, result?, error?}
 *
 * Tools are exposed to the LLM as a single block of text inside the
 * system prompt (see agentLoop.js). The LLM must reply with strict JSON
 * to invoke a tool; everything else is treated as the final answer.
 */
import {
  getWorkspaceTree,
  readWorkspaceFile,
  createFile,
  createFolder,
  writeFileContent,
  deleteItem,
  uploadFromUrl,
  searchWorkspaceContent,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'
import { runSandboxCommand } from './agentSandbox.js'
import { listOpsServices, runOpsAction } from './ops.js'
import { browserOpen, browserScreenshot, browserClick, browserType, browserClose } from './browserTools.js'

// ── Utility ─────────────────────────────────────────────────────────────────
function truncate(str, max = 8000) {
  const s = String(str ?? '')
  return s.length > max ? s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]` : s
}

function ok(result) { return { ok: true, result } }
function err(message) { return { ok: false, error: String(message || 'unknown error') } }

function drillTree(tree, relPath = '') {
  const parts = String(relPath || '').split('/').filter(Boolean)
  let node = tree
  for (const part of parts) {
    const children = Array.isArray(node?.children) ? node.children : []
    const next = children.find((c) => c.name === part)
    if (!next) return null
    node = next
  }
  return node
}

function shellQuote(value = '') {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function safeWorkspaceCwd(relPath = '') {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (raw.includes('\0') || raw === '..' || raw.startsWith('../') || raw.includes('/../')) {
    throw new Error('invalid workspace path')
  }
  return raw ? `/workspace/${raw}` : '/workspace'
}

async function runGit({ path = '', command, timeout_sec = 30 } = {}) {
  if (!command) return err('command is required')
  try {
    const r = await runSandboxCommand({
      command,
      cwd: safeWorkspaceCwd(path),
      timeoutMs: Math.min(120_000, Math.max(1_000, Number(timeout_sec) * 1000 || 30_000)),
    })
    return ok({
      stdout: truncate(r.stdout, 10000),
      stderr: truncate(r.stderr, 4000),
      exitCode: r.exitCode,
      truncated: r.truncated || false,
    })
  } catch (e) { return err(e.message) }
}


function collectProjectsFromTree(tree) {
  const markers = new Set(['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'composer.json', 'requirements.txt'])
  const projects = []

  function walk(node) {
    if (!node || node.type !== 'dir') return
    const children = Array.isArray(node.children) ? node.children : []
    const names = new Set(children.map((child) => child.name))
    const found = [...markers].filter((name) => names.has(name))
    const hasReadme = children.some((child) => /^readme(\..*)?$/i.test(child.name))
    if (found.length || (hasReadme && children.some((child) => child.type === 'dir' && ['src', 'server', 'app', 'lib'].includes(child.name)))) {
      projects.push({
        path: node.path || '/',
        markers: found,
        hasReadme,
        children: children.slice(0, 25).map((child) => ({ name: child.name, type: child.type, path: child.path })),
      })
    }
    for (const child of children) walk(child)
  }

  walk(tree)
  return projects
}

// ── Tool registry ───────────────────────────────────────────────────────────
export const TOOLS = {

  // ── Workspace: read ────────────────────────────────────────────────────
  list_files: {
    description: 'List files and folders in the workspace as a tree. Use this first to discover what is available.',
    params: {
      path: { type: 'string', optional: true, description: 'Subfolder path relative to workspace root. Empty = root.' },
      show_hidden: { type: 'boolean', optional: true, description: 'Include dotfiles. Default: false.' },
    },
    handler: async ({ path = '', show_hidden = false } = {}) => {
      try {
        const tree = await getWorkspaceTree(Boolean(show_hidden))
        // If a subpath was requested, drill into it
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

  find_projects: {
    description: 'Find likely project roots in the workspace by looking for package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, composer.json, requirements.txt and README+src/server markers. Use this after downloading archives when files are nested.',
    params: {},
    handler: async () => {
      try {
        const tree = await getWorkspaceTree(false)
        const projects = collectProjectsFromTree(tree)
        return ok({ count: projects.length, projects: projects.slice(0, 20) })
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

  // ── Workspace: write ───────────────────────────────────────────────────
  write_file: {
    description: 'Create or fully overwrite a text file in the workspace. Use this for any file you want to save or modify wholesale.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root.' },
      content: { type: 'string', required: true, description: 'Full file contents to write.' },
    },
    handler: async ({ path, content = '' } = {}) => {
      if (!path) return err('path is required')
      try {
        // Try create first; if it exists, overwrite via writeFileContent
        try {
          // createFile expects (parentRel, name, content)
          const parts = String(path).split('/').filter(Boolean)
          const name = parts.pop()
          const parent = parts.join('/')
          if (parent) {
            // Ensure parent folders exist
            const segs = parent.split('/')
            let acc = ''
            for (const seg of segs) {
              const here = acc ? acc + '/' + seg : seg
              try { await createFolder(acc, seg) } catch { /* exists */ }
              acc = here
            }
          }
          await createFile(parent, name, String(content))
        } catch {
          // Already exists — overwrite
          await writeFileContent(path, String(content))
        }
        return ok({ path, bytes: Buffer.byteLength(String(content), 'utf8') })
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
        return ok({ path, replaced: 1, newLength: updated.length })
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

  download_url: {
    description: 'Download a public URL into the workspace. Supports binary files and auto-extracts ZIP/TAR/TGZ archives. For GitHub blob URLs it downloads the raw file; for GitHub repo/tree URLs it downloads and extracts the repository archive.',
    params: {
      url: { type: 'string', required: true, description: 'Public http(s) URL. Examples: raw file URL, GitHub blob URL, GitHub repo URL.' },
      path: { type: 'string', optional: true, description: 'Destination folder relative to workspace root. Empty = root.' },
      branch: { type: 'string', optional: true, description: 'Branch/ref for GitHub repo/tree URLs. Default: main.' },
    },
    handler: async ({ url, path = '', branch = '' } = {}) => {
      if (!url) return err('url is required')
      try {
        const parentPath = String(path || '')
        const saved = await uploadFromUrl(parentPath, String(url), { branch: String(branch || '') })
        const tree = await getWorkspaceTree(false)
        const node = drillTree(tree, parentPath) || tree
        return ok({
          url,
          destination: parentPath || '/',
          ...saved,
          tree: node,
        })
      } catch (e) { return err(e.message) }
    },
  },

  // ── Git ────────────────────────────────────────────────────────────────
  git_status: {
    description: 'Show git status and current branch for a repository inside the workspace.',
    params: {
      path: { type: 'string', optional: true, description: 'Repository folder relative to workspace root. Empty = workspace root.' },
    },
    handler: async ({ path = '' } = {}) => runGit({
      path,
      command: 'git rev-parse --show-toplevel 2>/dev/null && git status --short --branch',
    }),
  },

  git_diff: {
    description: 'Show git diff for a repository inside the workspace. Use staged=true for --cached diff.',
    params: {
      path: { type: 'string', optional: true, description: 'Repository folder relative to workspace root.' },
      staged: { type: 'boolean', optional: true, description: 'Show staged diff (--cached). Default false.' },
      file: { type: 'string', optional: true, description: 'Optional file path relative to repository folder.' },
    },
    handler: async ({ path = '', staged = false, file = '' } = {}) => {
      return runGit({ path, command: `git diff --no-ext-diff ${staged ? '--cached ' : ''}--stat && git diff --no-ext-diff ${staged ? '--cached ' : ''}-- ${file ? shellQuote(file) : '.'}`.replace('-- --', '--') })
    },
  },

  git_commit: {
    description: 'Create a git commit in a workspace repository. By default stages all changes first. Use only after reviewing git_diff.',
    params: {
      path: { type: 'string', optional: true, description: 'Repository folder relative to workspace root.' },
      message: { type: 'string', required: true, description: 'Commit message.' },
      add_all: { type: 'boolean', optional: true, description: 'Run git add -A before committing. Default true.' },
    },
    handler: async ({ path = '', message = '', add_all = true } = {}) => {
      if (!message) return err('message is required')
      return runGit({
        path,
        command: `${add_all ? 'git add -A && ' : ''}git -c user.name='BrowserAI Agent' -c user.email='agent@browserai.local' commit -m ${shellQuote(message)} && git status --short --branch`,
        timeout_sec: 60,
      })
    },
  },

  git_clone: {
    description: 'Clone a public git repository into the workspace. Prefer download_url for GitHub archives when git history is not needed.',
    params: {
      url: { type: 'string', required: true, description: 'Public git URL, e.g. https://github.com/user/repo.git' },
      path: { type: 'string', optional: true, description: 'Destination parent folder relative to workspace root. Empty = root.' },
      name: { type: 'string', optional: true, description: 'Optional destination folder name.' },
      depth: { type: 'number', optional: true, description: 'Clone depth. Default 1.' },
    },
    handler: async ({ url, path = '', name = '', depth = 1 } = {}) => {
      if (!url) return err('url is required')
      const depthArg = Math.min(100, Math.max(1, Number(depth) || 1))
      const nameArg = name ? ` ${shellQuote(name)}` : ''
      return runGit({
        path,
        command: `git clone --depth ${depthArg} ${shellQuote(url)}${nameArg} && find . -maxdepth 2 -type f | sed 's#^./##' | head -80`,
        timeout_sec: 120,
      })
    },
  },

  git_pull: {
    description: 'Run git pull --ff-only in a workspace repository.',
    params: {
      path: { type: 'string', optional: true, description: 'Repository folder relative to workspace root.' },
    },
    handler: async ({ path = '' } = {}) => runGit({ path, command: 'git pull --ff-only', timeout_sec: 60 }),
  },

  // ── Web ────────────────────────────────────────────────────────────────
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

  // ── Browser automation ───────────────────────────────────────────────
  browser_open: {
    description: 'Open a web page in a headless browser, collect title/text/console/network errors, and save a screenshot into workspace. Useful for UI debugging and visual checks.',
    params: {
      url: { type: 'string', required: true, description: 'URL starting with http:// or https://.' },
      waitMs: { type: 'number', optional: true, description: 'Milliseconds to wait after load. Default 1500.' },
      screenshot: { type: 'boolean', optional: true, description: 'Save screenshot. Default true.' },
    },
    handler: async (args = {}) => {
      try { return ok(await browserOpen(args)) } catch (e) { return err(e.message) }
    },
  },

  browser_screenshot: {
    description: 'Take a screenshot of an existing browser session and save it into workspace.',
    params: {
      sessionId: { type: 'string', required: true, description: 'Session id returned by browser_open.' },
      path: { type: 'string', optional: true, description: 'Optional workspace path for PNG screenshot.' },
    },
    handler: async (args = {}) => {
      try { return ok(await browserScreenshot(args)) } catch (e) { return err(e.message) }
    },
  },

  browser_click: {
    description: 'Click an element in an existing browser session by CSS selector or visible text; returns updated screenshot and diagnostics.',
    params: {
      sessionId: { type: 'string', required: true, description: 'Session id returned by browser_open.' },
      selector: { type: 'string', optional: true, description: 'CSS selector to click.' },
      text: { type: 'string', optional: true, description: 'Visible text to click if selector is omitted.' },
      waitMs: { type: 'number', optional: true, description: 'Wait after click. Default 1000.' },
    },
    handler: async (args = {}) => {
      try { return ok(await browserClick(args)) } catch (e) { return err(e.message) }
    },
  },

  browser_type: {
    description: 'Fill an input/textarea/contenteditable element by CSS selector; optionally press Enter; returns screenshot and diagnostics.',
    params: {
      sessionId: { type: 'string', required: true, description: 'Session id returned by browser_open.' },
      selector: { type: 'string', required: true, description: 'CSS selector for input.' },
      text: { type: 'string', required: true, description: 'Text to type/fill.' },
      pressEnter: { type: 'boolean', optional: true, description: 'Press Enter after filling. Default false.' },
      waitMs: { type: 'number', optional: true, description: 'Wait after typing. Default 1000.' },
    },
    handler: async (args = {}) => {
      try { return ok(await browserType(args)) } catch (e) { return err(e.message) }
    },
  },

  browser_close: {
    description: 'Close a browser session.',
    params: { sessionId: { type: 'string', required: true, description: 'Session id returned by browser_open.' } },
    handler: async (args = {}) => {
      try { return ok(await browserClose(args)) } catch (e) { return err(e.message) }
    },
  },

  // ── Ops / service connectors ──────────────────────────────────────────
  ops_list_services: {
    description: 'List configured external/service connectors and their allowed actions (GitHub/Timeweb/Docker/Telegram/etc. as configured on the server). Use this before ops_run_action.',
    params: {},
    handler: async () => ok({ services: listOpsServices() }),
  },

  ops_run_action: {
    description: 'Run a safe or confirmed server-side service action without exposing secrets. Dangerous actions return requiresConfirmation unless args.confirm=true. For dangerous actions, ask_user for confirmation first.',
    params: {
      service: { type: 'string', required: true, description: 'Service id from ops_list_services, e.g. browserai or telegram.' },
      action: { type: 'string', required: true, description: 'Action id from ops_list_services, e.g. health, docker_logs, deploy.' },
      params: { type: 'object', optional: true, description: 'Action parameters, e.g. {service:"browserai", tail:120} or {text:"..."}.' },
      confirm: { type: 'boolean', optional: true, description: 'Must be true for dangerous actions after explicit user confirmation.' },
    },
    handler: async ({ service, action, params = {}, confirm = false } = {}) => {
      if (!service || !action) return err('service and action are required')
      try {
        const result = await runOpsAction({ service, action, params, confirm })
        return ok(result)
      } catch (e) { return err(e.message) }
    },
  },

  // ── Interactive: ask the user a multi-select question ──────────────────
  // The actual UI rendering happens client-side: the agent loop emits
  // an "ask_user" SSE event with the spec, the UI shows a card with
  // checkboxes + optional free-text input, and on submit POSTs the
  // answer back to /api/agent/answer which resolves a pending Promise.
  //
  // Because of that round-trip the handler here is just a *marker* —
  // the loop intercepts the call before invokeTool() is reached.
  ask_user: {
    description: 'Ask the user a multi-select question with optional custom text. Use this when you need clarification or a decision from the user. Returns the user\'s selection as { selected: [option_id, ...], custom?: string }.',
    params: {
      question:    { type: 'string', required: true, description: 'The question text shown to the user.' },
      options:     { type: 'array',  required: true, description: 'Array of {id: string, label: string, description?: string} — choices the user can pick.' },
      multi:       { type: 'boolean', optional: true, description: 'Allow multiple selections. Default: true.' },
      allow_custom: { type: 'boolean', optional: true, description: 'Allow the user to type additional free-form text. Default: true.' },
    },
    // Placeholder handler — never actually invoked because the loop
    // short-circuits this tool. Kept so the schema validates.
    handler: async () => ok({ pending: true }),
  },

  // ── Shell (sandboxed) ───────────────────────────────────────────────────
  bash: {
    description: 'Run a shell command inside an isolated Linux sandbox that has a copy of the workspace mounted at /workspace. Useful for git, npm, node, curl, grep, build steps, etc. Output is returned. Timeout 30s.',
    params: {
      command: { type: 'string', required: true, description: 'Shell command, e.g. "ls -la /workspace" or "node -e \\"console.log(1+1)\\""' },
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

  // ── Verification: check code before deploying (mirrors the human-agent flow) ──
  verify_code: {
    description: 'Verify workspace code before committing/deploying. Runs lightweight checks in the sandbox: Node syntax check (node --check) on changed/!given JS files, optional npm script (e.g. lint/test/build), or a custom command. Use this BEFORE git_commit / ops deploy to avoid shipping broken code. Returns pass/fail per check.',
    params: {
      path: { type: 'string', optional: true, description: 'Repo/subfolder relative to workspace root. Empty = workspace root.' },
      node_check_glob: { type: 'string', optional: true, description: 'Glob for files to run "node --check" on, e.g. "server/**/*.js" or "*.js". Default: skip if empty.' },
      npm_script: { type: 'string', optional: true, description: 'npm script to run, e.g. "lint", "test", "build". Runs "npm run <script>" if present in package.json.' },
      command: { type: 'string', optional: true, description: 'Custom verification shell command to run instead of/in addition to the above.' },
      timeout_sec: { type: 'number', optional: true, description: 'Max seconds for the whole verification, default 120, max 600.' },
    },
    handler: async ({ path = '', node_check_glob = '', npm_script = '', command = '', timeout_sec = 120 } = {}) => {
      const cwd = safeWorkspaceCwd(path)
      const timeoutMs = Math.min(600_000, Math.max(5_000, Number(timeout_sec) * 1000 || 120_000))
      const checks = []
      const runOne = async (name, cmd) => {
        try {
          const r = await runSandboxCommand({ command: cmd, cwd, timeoutMs })
          const passed = r.exitCode === 0
          checks.push({
            name,
            passed,
            exitCode: r.exitCode,
            stdout: truncate(r.stdout, 4000),
            stderr: truncate(r.stderr, 3000),
          })
          return passed
        } catch (e) {
          checks.push({ name, passed: false, error: e.message })
          return false
        }
      }

      if (node_check_glob) {
        // Run node --check on each matched .js file; fail if any errors.
        const glob = String(node_check_glob).replace(/'/g, '')
        const cmd = `set -e; found=0; fail=0; for f in $(find . -type f -path '${glob}' 2>/dev/null || true); do found=$((found+1)); node --check "$f" 2>&1 && echo "ok: $f" || { echo "FAIL: $f"; fail=1; }; done; echo "checked $found file(s)"; exit $fail`
        await runOne(`node --check ${glob}`, cmd)
      }
      if (npm_script) {
        const s = String(npm_script).replace(/[^a-zA-Z0-9:_-]/g, '')
        await runOne(`npm run ${s}`, `test -f package.json && npm run ${s} --if-present 2>&1 || echo "no package.json"`)
      }
      if (command) {
        await runOne('custom', String(command))
      }

      if (checks.length === 0) {
        return err('Nothing to verify — provide node_check_glob, npm_script, or command')
      }
      const allPassed = checks.every((c) => c.passed)
      return ok({ allPassed, checks })
    },
  },
}

// ── Schema for the system prompt ────────────────────────────────────────────
/**
 * Render the tool catalogue as plain text the LLM can read.
 */
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

/**
 * Invoke a tool by name. Returns the {ok, result|error} shape.
 */
export async function invokeTool(name, args = {}) {
  const tool = TOOLS[name]
  if (!tool) return err(`Unknown tool: ${name}`)
  if (typeof tool.handler !== 'function') return err(`Tool ${name} has no handler`)
  try {
    return await tool.handler(args || {})
  } catch (e) {
    return err(e?.message || String(e))
  }
}
