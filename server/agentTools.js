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
  searchWorkspaceContent,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'
import { runSandboxCommand } from './agentSandbox.js'

// ── Utility ─────────────────────────────────────────────────────────────────
function truncate(str, max = 8000) {
  const s = String(str ?? '')
  return s.length > max ? s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]` : s
}

function ok(result) { return { ok: true, result } }
function err(message) { return { ok: false, error: String(message || 'unknown error') } }

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
}

// ── Schema for the system prompt ────────────────────────────────────────────
/**
 * Render the tool catalogue as plain text the LLM can read.
 */

// Minimal tool set for low-complexity runs (must match agentLoop.js lite filter)
export const LITE_TOOL_NAMES = [
  'list_files', 'read_file', 'write_file', 'edit_file', 'search_files',
  'bash', 'web_search', 'web_fetch', 'ask_user',
  'delete_file',
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
