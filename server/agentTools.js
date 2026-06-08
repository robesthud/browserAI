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
  getFileHistory,
  restoreFileRevision,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'
import { runSandboxCommand } from './agentSandbox.js'
import { listOpsServices, runOpsAction } from './ops.js'
import { browserOpen, browserScreenshot, browserClick, browserType, browserClose } from './browserTools.js'
import { upsertFact, forgetFact, listFacts } from './userMemory.js'
import { addDocument, deleteDocument, listDocuments, searchKnowledge } from './knowledgeBase.js'

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

// ── Auto-diagnostics after a write ─────────────────────────────────────────
//
// Cline-style "what changed → what broke" feedback loop. After a successful
// edit_file / write_file we run a cheap, in-process syntax check on the
// file (based on its extension) and tag the result onto the tool's payload
// as `diagnostics`. The agent SEES the syntax error in the very next turn
// without having to remember to call verify_code, which historically it
// often forgot. Best-effort: any internal error is swallowed and reported
// as `diagnostics: { available: false }`.
async function quickSyntaxCheck(relPath, content) {
  try {
    const ext = String(relPath || '').toLowerCase().split('.').pop()
    // JSON
    if (ext === 'json' || ext === 'webmanifest' || relPath.endsWith('package-lock.json')) {
      try {
        JSON.parse(String(content))
        return { available: true, ok: true, kind: 'json', lang: 'json' }
      } catch (e) {
        return { available: true, ok: false, kind: 'json', lang: 'json', error: e.message }
      }
    }
    // JavaScript / TypeScript / JSX
    if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext)) {
      // Use Node's --check via a subprocess? Risky and slow.
      // Instead: a tiny, fast parser pass with Function() for plain .js,
      // and a brace/paren balance check for everything else.
      if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
        try {
          // eslint-disable-next-line no-new-func
          new Function(String(content))
          return { available: true, ok: true, kind: 'syntax', lang: ext }
        } catch (e) {
          // Function() can't parse ESM `import` statements — fall through
          // to brace balance check in that case.
          if (!/import\s|export\s/.test(content)) {
            return { available: true, ok: false, kind: 'syntax', lang: ext, error: e.message }
          }
        }
      }
      // Brace / paren / bracket balance — catches the most common copy-paste
      // mistakes without needing a real parser.
      const balance = checkBalance(String(content))
      if (!balance.ok) {
        return { available: true, ok: false, kind: 'balance', lang: ext, error: balance.error }
      }
      return { available: true, ok: true, kind: 'balance', lang: ext }
    }
    // YAML — extremely lightweight indentation check
    if (ext === 'yml' || ext === 'yaml') {
      // Not implementing a YAML parser here; just report skip.
      return { available: false, kind: 'yaml-skip' }
    }
    return { available: false, kind: 'unknown-ext' }
  } catch (e) {
    return { available: false, error: e?.message || String(e) }
  }
}

function checkBalance(src) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const closes = new Set([')', ']', '}'])
  const stack = []
  let line = 1, col = 1
  let inStr = null     // '"', "'", '`'
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\n') { line++; col = 1; if (inLineComment) inLineComment = false; continue }
    col++
    if (inLineComment) continue
    if (inBlockComment) { if (ch === '*' && src[i + 1] === '/') { inBlockComment = false; i++ }; continue }
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '/' && src[i + 1] === '/') { inLineComment = true; i++; continue }
    if (ch === '/' && src[i + 1] === '*') { inBlockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (pairs[ch]) { stack.push({ ch, line, col }); continue }
    if (closes.has(ch)) {
      const top = stack.pop()
      if (!top || pairs[top.ch] !== ch) {
        return { ok: false, error: `Unbalanced "${ch}" at line ${line}, col ${col}` }
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1]
    return { ok: false, error: `Unclosed "${top.ch}" opened at line ${top.line}, col ${top.col}` }
  }
  return { ok: true }
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
        const diagnostics = await quickSyntaxCheck(path, String(content))
        return ok({ path, bytes: Buffer.byteLength(String(content), 'utf8'), diagnostics })
      } catch (e) { return err(e.message) }
    },
  },

  edit_file: {
    description:
      'Replace one or more substrings inside an existing text file. ' +
      'For a single edit pass old_text + new_text. ' +
      'For multiple surgical edits in the same file pass `edits: [{old_text, new_text}, …]` — all are applied in order, each old_text must appear exactly once at the moment its turn comes (no race). This avoids round-tripping the LLM 5 times for 5 small changes in one file.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root.' },
      old_text: { type: 'string', optional: true, description: 'Exact substring to find (single-edit mode). Must appear exactly once.' },
      new_text: { type: 'string', optional: true, description: 'Replacement text (single-edit mode). Use empty string to delete.' },
      edits: { type: 'string', optional: true, description: 'JSON array of { old_text, new_text } objects for multiple edits in one call.' },
    },
    handler: async ({ path, old_text, new_text = '', edits } = {}) => {
      if (!path) return err('path is required')
      try {
        const file = await readWorkspaceFile(path)
        const original = file?.text ?? file?.content
        if (typeof original !== 'string') return err(`File is binary or unreadable: ${path}`)

        // Normalise to a list of {old_text, new_text}.
        let list = []
        if (Array.isArray(edits)) {
          list = edits
        } else if (typeof edits === 'string' && edits.trim()) {
          try { list = JSON.parse(edits) } catch { return err('edits must be valid JSON array') }
        } else if (old_text != null) {
          list = [{ old_text, new_text }]
        } else {
          return err('provide either old_text/new_text or edits[]')
        }
        if (!Array.isArray(list) || list.length === 0) return err('edits[] is empty')

        let current = original
        const applied = []
        for (let i = 0; i < list.length; i += 1) {
          const e = list[i] || {}
          const o = String(e.old_text ?? '')
          const n = String(e.new_text ?? '')
          if (!o) return err(`edit #${i + 1}: old_text is empty`)
          const count = current.split(o).length - 1
          if (count === 0) return err(`edit #${i + 1}: old_text not found in ${path}`)
          if (count > 1) return err(`edit #${i + 1}: old_text appears ${count} times in ${path}; refine to make it unique`)
          current = current.replace(o, n)
          applied.push({ idx: i + 1, deltaBytes: n.length - o.length })
        }
        await writeFileContent(path, current)
        const diagnostics = await quickSyntaxCheck(path, current)
        return ok({
          path,
          replaced: applied.length,
          deltaBytes: current.length - original.length,
          newLength: current.length,
          // Also return a tiny unified-ish diff hint so the JobCard /
          // AgentToolBlock can show line counts without parsing JSON.
          edits: applied,
          oldLines: original.split('\n').length,
          newLines: current.split('\n').length,
          diagnostics,
        })
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

  file_history: {
    description:
      'List previous saved revisions of a file (from /workspace/.history). ' +
      'Each entry has a revisionId you can pass to restore_file. Use this when you (or the user) want to undo a recent edit_file / write_file.',
    params: {
      path: { type: 'string', required: true, description: 'Path of the file whose history you want.' },
      limit: { type: 'number', optional: true, description: 'Cap on returned revisions, default 10, max 30.' },
    },
    handler: async ({ path, limit = 10 } = {}) => {
      if (!path) return err('path is required')
      try {
        const items = await getFileHistory(path)
        const cap = Math.min(30, Math.max(1, Number(limit) || 10))
        return ok({
          path,
          count: items.length,
          revisions: items.slice(0, cap).map((r) => ({
            revisionId: r.revisionId,
            createdAt: new Date(r.createdAt).toISOString(),
            size: r.size,
            reason: r.reason,
          })),
        })
      } catch (e) { return err(e.message) }
    },
  },

  restore_file: {
    description:
      'Restore a previous revision of a file by revisionId (obtained via file_history). The current file is snapshotted as a new "restore" revision FIRST so you can undo the undo. Use this for conversational repair: if you (or the user) realise the last edit was wrong, list file_history → restore_file.',
    params: {
      path: { type: 'string', required: true, description: 'Path of the file to restore.' },
      revision_id: { type: 'string', required: true, description: 'revisionId from file_history.' },
    },
    handler: async ({ path, revision_id } = {}) => {
      if (!path || !revision_id) return err('path and revision_id are required')
      try {
        await restoreFileRevision(path, revision_id)
        return ok({ path, restored: revision_id })
      } catch (e) { return err(e.message) }
    },
  },

  // ── Planning ──────────────────────────────────────────────────────────
  // Lightweight TODO list the agent maintains during a multi-step task.
  // Renders as a checklist in the UI so the user can see overall progress
  // ("step 4 of 12") instead of staring at an opaque spinner. Pure state —
  // the server doesn't validate task semantics, just stores and replays.
  // We expose three operations through three tools so each appears as a
  // discrete event in the chat timeline.
  plan_set: {
    description:
      'Set or REPLACE the current task plan as a checklist of steps. Use this at the start of a non-trivial multi-step request so the user sees the overall plan and progress. Each step is a short imperative phrase ("Read server/index.js", "Edit /api/chat route", "Run verify_code").',
    params: {
      title: { type: 'string', optional: true, description: 'Overall goal of the plan (1 short line).' },
      steps: { type: 'string', required: true, description: 'JSON array of step strings.' },
    },
    handler: async ({ title = '', steps } = {}) => {
      let list = []
      if (Array.isArray(steps)) list = steps
      else if (typeof steps === 'string') {
        try { list = JSON.parse(steps) } catch { return err('steps must be a JSON array') }
      }
      if (!Array.isArray(list) || list.length === 0) return err('steps[] is empty')
      const plan = list.slice(0, 30).map((s, i) => ({ idx: i + 1, text: String(s || '').slice(0, 200), done: false }))
      return ok({ title: String(title || '').slice(0, 200), plan })
    },
  },

  plan_check: {
    description:
      'Mark plan step(s) as DONE. Call this after you finish each meaningful step (a tool call or group of tool calls).',
    params: {
      indices: { type: 'string', required: true, description: 'JSON array of 1-based step indices to mark complete (e.g. [3] or [3,4]).' },
      note: { type: 'string', optional: true, description: 'Optional 1-line note about how this step was done.' },
    },
    handler: async ({ indices, note = '' } = {}) => {
      let list = []
      if (Array.isArray(indices)) list = indices
      else if (typeof indices === 'string') {
        try { list = JSON.parse(indices) } catch { return err('indices must be a JSON array') }
      }
      const clean = list.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0 && n < 100)
      if (!clean.length) return err('no valid indices')
      return ok({ checked: clean, note: String(note || '').slice(0, 200) })
    },
  },

  // ── Cross-session memory ───────────────────────────────────────────────
  // Pure key/value facts persisted in the SQLite next to user accounts.
  // Rendered into every system prompt for this user (see userMemory.js).
  // Use to remember stable preferences ('Tailwind v3, not v4'), recurring
  // pointers ('main repo: /opt/browserai'), conventions ('commits in EN').
  remember_fact: {
    description:
      'Remember a SHORT cross-session fact about the user (preference, convention, recurring context). Key < 120 chars, value < 1 KB. Idempotent — re-calling with the same key updates the value. The fact is automatically rendered into every future agent system prompt so you (and other agents) will recall it.',
    params: {
      key:   { type: 'string', required: true, description: 'Stable identifier — e.g. "tailwind_version" or "main_repo_path".' },
      value: { type: 'string', required: true, description: 'Free-form text the fact stores.' },
    },
    handler: async ({ key, value, _userId } = {}) => {
      if (!_userId) return err('user-scoped tool: no user id in context')
      try { return ok(upsertFact(_userId, key, value)) }
      catch (e) { return err(e.message) }
    },
  },
  forget_fact: {
    description: 'Delete a previously-remembered fact by key.',
    params: { key: { type: 'string', required: true, description: 'The key to delete.' } },
    handler: async ({ key, _userId } = {}) => {
      if (!_userId) return err('user-scoped tool: no user id in context')
      try { return ok(forgetFact(_userId, key)) }
      catch (e) { return err(e.message) }
    },
  },
  recall_facts: {
    description: 'List every remembered fact for the current user (key, value, updated_at). Mostly diagnostic — facts are already injected into the system prompt automatically.',
    params: {},
    handler: async ({ _userId } = {}) => {
      if (!_userId) return err('user-scoped tool: no user id in context')
      try { return ok({ facts: listFacts(_userId) }) }
      catch (e) { return err(e.message) }
    },
  },

  // ── Knowledge base (RAG) ───────────────────────────────────────────────
  // Per-user document store with TF-IDF search. Add long docs (PDFs/MDs/
  // logs/manuals) once, then query relevant passages instead of pasting
  // the whole document into every prompt.
  kb_add: {
    description: 'Add a document to the user knowledge base. Text is chunked and indexed automatically. Use for long docs you want to query later via kb_search — instead of re-reading them in full every turn.',
    params: {
      title:  { type: 'string', required: true, description: 'Human-readable title.' },
      text:   { type: 'string', required: true, description: 'Full text content (≤ 256 KB).' },
      source: { type: 'string', optional: true, description: 'Optional URL / file path for provenance.' },
    },
    handler: async ({ title, text, source = '', _userId } = {}) => {
      if (!_userId) return err('user-scoped tool: no user id in context')
      try { return ok(addDocument(_userId, { title, source, text })) }
      catch (e) { return err(e.message) }
    },
  },
  kb_search: {
    description: 'Search the user knowledge base for passages relevant to a query. Returns top-K chunks (text, score, doc title). Use BEFORE asking the LLM to recall something — much cheaper than re-reading source files.',
    params: {
      query: { type: 'string', required: true, description: 'Natural-language query.' },
      top_k: { type: 'number', optional: true, description: 'How many passages, default 5, max 20.' },
    },
    handler: async ({ query, top_k = 5, _userId } = {}) => {
      if (!_userId) return err('user-scoped tool: no user id in context')
      try { return ok({ results: searchKnowledge(_userId, query, { topK: top_k }) }) }
      catch (e) { return err(e.message) }
    },
  },
  kb_list: {
    description: 'List all documents in the user knowledge base (id, title, source, chunks, bytes).',
    params: {},
    handler: async ({ _userId } = {}) => {
      if (!_userId) return err('user-scoped tool: no user id in context')
      try { return ok({ documents: listDocuments(_userId) }) }
      catch (e) { return err(e.message) }
    },
  },
  kb_delete: {
    description: 'Remove a knowledge-base document by id.',
    params: { id: { type: 'string', required: true } },
    handler: async ({ id, _userId } = {}) => {
      if (!_userId) return err('user-scoped tool: no user id in context')
      try { return ok(deleteDocument(_userId, id)) }
      catch (e) { return err(e.message) }
    },
  },

  // ── Multi-file refactor ────────────────────────────────────────────────
  // Single-call rename / find-replace across many files. Saves N round-
  // trips per file when the user says "rename X to Y everywhere".
  replace_across_files: {
    description:
      'Find a substring (or regex) in many workspace files and replace it. Returns a per-file count of replacements. Skips binary files. Atomic per-file (each file is read → replaced → written as one op). Use this for "rename X to Y in the whole repo" requests instead of N×edit_file calls.',
    params: {
      pattern:     { type: 'string', required: true, description: 'Substring OR JavaScript regex literal: /foo/g.' },
      replacement: { type: 'string', required: true, description: 'Replacement text. $1, $2 etc work for regex captures.' },
      paths:       { type: 'string', optional: true, description: 'JSON array of relative paths/globs to scan. Default: every text file in the workspace.' },
      max_files:   { type: 'number', optional: true, description: 'Safety cap on files to touch. Default 50.' },
    },
    handler: async ({ pattern, replacement = '', paths, max_files = 50 } = {}) => {
      if (!pattern) return err('pattern is required')
      // Parse pattern: support /…/flags or plain substring.
      let re
      const m = String(pattern).match(/^\/(.*)\/([gimsuy]*)$/)
      if (m) {
        try { re = new RegExp(m[1], m[2] || 'g') } catch (e) { return err(`bad regex: ${e.message}`) }
      } else {
        const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re = new RegExp(escaped, 'g')
      }
      let list = []
      if (Array.isArray(paths)) list = paths
      else if (typeof paths === 'string' && paths.trim()) {
        try { list = JSON.parse(paths) } catch { return err('paths must be JSON array') }
      }
      // If no paths given: walk the workspace tree and take every text file.
      if (!list.length) {
        const tree = await getWorkspaceTree(false)
        const flat = []
        const walk = (node) => {
          if (!node) return
          if (node.type === 'file' && /\.(js|jsx|ts|tsx|json|md|html|css|scss|py|sh|yml|yaml|sql|txt|toml|ini|env|xml|conf|rs|go|java|kt|rb|php|c|h|cpp)$/i.test(node.name)) flat.push(node.path)
          for (const c of node.children || []) walk(c)
        }
        walk(tree)
        list = flat.slice(0, Math.min(500, Number(max_files) * 5 || 250))
      }
      const cap = Math.min(500, Math.max(1, Number(max_files) || 50))
      const touched = []
      let stoppedAt = 0
      for (const p of list) {
        if (touched.length >= cap) { stoppedAt = touched.length; break }
        try {
          const f = await readWorkspaceFile(p)
          const src = f?.text ?? f?.content
          if (typeof src !== 'string') continue
          const next = src.replace(re, replacement)
          if (next === src) continue
          const matches = (src.match(re) || []).length
          await writeFileContent(p, next)
          touched.push({ path: p, replacements: matches, deltaBytes: next.length - src.length })
        } catch (e) {
          // Skip files we couldn't read/write but report once.
          touched.push({ path: p, error: e.message })
        }
      }
      return ok({
        scanned: list.length,
        touched: touched.filter((t) => !t.error).length,
        errors: touched.filter((t) => t.error),
        files: touched,
        stoppedAt,
      })
    },
  },

  // ── Test loop ──────────────────────────────────────────────────────────
  // Convenience wrapper around verify_code: auto-detect the project's test
  // runner (npm test / pytest / cargo test / go test) and run it. Returns
  // pass/fail. Used as the "after every edit" guard in TDD-style flows.
  run_tests: {
    description: 'Auto-detect and run the project test suite (npm test / pytest / go test / cargo test). Returns pass/fail + per-suite summary. Use after a batch of edits and BEFORE git_commit / git_push.',
    params: {
      path:        { type: 'string', optional: true, description: 'Subdirectory to run from. Default: workspace root.' },
      timeout_sec: { type: 'number', optional: true, description: 'Max seconds, default 180.' },
    },
    handler: async ({ path = '', timeout_sec = 180 } = {}) => {
      const cwd = safeWorkspaceCwd(path)
      // Probe what's available — single bash call, output parsed to pick
      // the right runner.
      const probe = await runSandboxCommand({
        command:
          'set -e\n' +
          '[ -f package.json ] && echo NODE && jq -r ".scripts.test // empty" package.json 2>/dev/null || cat package.json 2>/dev/null | grep -o "\\"test\\": *\\"[^\\"]*\\"" | head -1\n' +
          '[ -f pyproject.toml ] || [ -f setup.py ] && echo PY\n' +
          '[ -f Cargo.toml ] && echo RUST\n' +
          '[ -f go.mod ] && echo GO\n' +
          '[ -f Gemfile ] && echo RUBY\n',
        cwd,
        timeoutMs: 8000,
      })
      const probeOut = probe.stdout || ''
      let cmd = ''
      let runner = ''
      if (probeOut.includes('NODE')) { runner = 'npm test'; cmd = 'npm test --silent --if-present' }
      else if (probeOut.includes('PY'))   { runner = 'pytest';      cmd = 'pytest -q || python -m pytest -q' }
      else if (probeOut.includes('RUST')) { runner = 'cargo test';  cmd = 'cargo test --quiet' }
      else if (probeOut.includes('GO'))   { runner = 'go test';     cmd = 'go test ./...' }
      else if (probeOut.includes('RUBY')) { runner = 'bundle test'; cmd = 'bundle exec rake test || bundle exec rspec' }
      else return err('No supported test runner detected (package.json / pyproject.toml / Cargo.toml / go.mod / Gemfile).')
      try {
        const r = await runSandboxCommand({ command: cmd, cwd, timeoutMs: Math.min(600_000, Math.max(10_000, Number(timeout_sec) * 1000 || 180_000)) })
        return ok({
          runner,
          passed: r.exitCode === 0,
          exitCode: r.exitCode,
          stdout: truncate(r.stdout, 5000),
          stderr: truncate(r.stderr, 3000),
        })
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

  git_push: {
    description:
      'Push the current branch to origin. If GITHUB_TOKEN is set on the server, the remote URL is rewritten in-place to https://x-access-token:<TOKEN>@github.com/… so push works on a fresh clone without manual git-credential setup. Use AFTER git_commit + verify_code, and AFTER ask_user confirmation if the repo is shared.',
    params: {
      path: { type: 'string', optional: true, description: 'Repository folder relative to workspace root.' },
      branch: { type: 'string', optional: true, description: 'Branch to push. Default: current.' },
      set_upstream: { type: 'boolean', optional: true, description: 'Add --set-upstream origin <branch>. Default false.' },
    },
    handler: async ({ path = '', branch = '', set_upstream = false } = {}) => {
      // We can not rely on GITHUB_TOKEN inside the sandbox container, so we
      // rewrite the remote URL through bash before pushing — only when the
      // existing remote points at github.com over https.
      const branchPart = branch ? ` ${branch}` : ''
      const upstreamPart = set_upstream && branch ? ` --set-upstream origin ${branch}` : ''
      const cmd = [
        'set -e',
        'orig_url="$(git config --get remote.origin.url || true)"',
        'if [ -n "${GITHUB_TOKEN:-}" ] && echo "$orig_url" | grep -q "^https://github.com/"; then',
        '  authed="$(echo "$orig_url" | sed "s#https://github.com/#https://x-access-token:${GITHUB_TOKEN}@github.com/#")";',
        '  git remote set-url origin "$authed";',
        'fi',
        `git push${upstreamPart || branchPart}`,
        // Always restore the clean URL so we never persist the token on disk.
        'git remote set-url origin "$orig_url"',
        'git rev-parse HEAD',
      ].join('\n')
      return runGit({ path, command: cmd, timeout_sec: 120 })
    },
  },

  github_pr_create: {
    description:
      'Open a pull request on GitHub for a workspace repository. Requires the ops service ' +
      '`github` to be configured (GITHUB_TOKEN env). Uses the current branch as the head ' +
      'and main as the base by default. Returns the PR url + number on success.',
    params: {
      path: { type: 'string', optional: true, description: 'Repository folder; used only for git_status logging.' },
      title: { type: 'string', required: true, description: 'PR title.' },
      body: { type: 'string', optional: true, description: 'PR body / description (markdown).' },
      head: { type: 'string', optional: true, description: 'Source branch. Default: current branch in the workspace clone.' },
      base: { type: 'string', optional: true, description: 'Target branch. Default: main.' },
      repo: { type: 'string', optional: true, description: '"owner/name" override. Default: GITHUB_REPO env.' },
    },
    handler: async ({ title, body = '', head = '', base = 'main', repo = '', path = '' } = {}) => {
      if (!title) return err('title is required')
      // Resolve head from local checkout if not given.
      if (!head) {
        const probe = await runGit({ path, command: 'git rev-parse --abbrev-ref HEAD' })
        if (!probe.ok) return err('could not resolve current branch: ' + (probe.error || ''))
        head = String(probe.result?.stdout || '').trim()
        if (!head || head === 'HEAD') return err('detached HEAD — please specify head=<branch>')
      }
      try {
        // Delegate to the existing ops connector so we share auth + redaction.
        const { runOpsAction } = await import('./ops.js')
        const r = await runOpsAction({
          service: 'github',
          action: 'create_pull_request',
          params: { title, body, head, base, repo },
          confirm: true,
        })
        return ok({ pr: r?.pull_request || r, head, base, title })
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

  // ── Vision: let the (text) agent actually "see" an image/screenshot ──
  // Tries every configured vision backend in order until one returns text:
  //   1. Gemini Web Proxy (free, default)
  //   2. OpenAI gpt-4o-mini   (if OPENAI_API_KEY)
  //   3. Anthropic claude-3-5-haiku (if ANTHROPIC_API_KEY)
  // The agent now also accepts a `data_url` directly so it can analyse
  // an image the user just attached, without having to save it first.
  analyze_image: {
    description:
      'Look at an image (workspace file OR direct data: URL) and ask a vision model about it. ' +
      'Tries Gemini Web Proxy first, falls back to OpenAI / Anthropic vision when keys are set on the server. ' +
      'Use this to inspect UI screenshots from browser_open, diagrams, photos the user attached, etc.',
    params: {
      path:     { type: 'string', optional: true, description: 'Workspace file path. Use this OR data_url.' },
      data_url: { type: 'string', optional: true, description: 'data:image/...;base64,... URL. Use this for one-shot analysis without saving the file.' },
      question: { type: 'string', optional: true, description: 'What to ask. Default: describe what is on the image in detail.' },
      model:    { type: 'string', optional: true, description: 'Force a specific provider: "gemini", "openai", "anthropic".' },
    },
    handler: async ({ path, data_url = '', question = '', model = '' } = {}) => {
      if (!path && !data_url) return err('path or data_url required')
      let dataUrl = data_url
      if (!dataUrl && path) {
        try {
          const file = await readWorkspaceFile(path)
          if (file?.kind !== 'image' || !file?.dataUrl) return err(`Not an image: ${path}`)
          dataUrl = file.dataUrl
        } catch (e) { return err(e.message) }
      }
      const prompt = String(question || '').trim() || 'Опиши, что изображено на этом изображении, подробно. Если это UI — перечисли видимые элементы, ошибки, текст.'

      const attempts = []
      const want = String(model || '').toLowerCase()
      const tryGemini = !want || want === 'gemini'
      const tryOpenAI = (!want || want === 'openai') && process.env.OPENAI_API_KEY
      const tryAnth   = (!want || want === 'anthropic') && process.env.ANTHROPIC_API_KEY

      if (tryGemini) {
        try {
          const url = (process.env.GEMINI_WEB_PROXY_URL || 'http://host.docker.internal:8080/v1').replace(/\/$/, '')
          const r = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-needed' },
            body: JSON.stringify({
              model: process.env.GEMINI_WEB_MODEL || 'gemini-2.5-flash',
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
            }),
            signal: AbortSignal.timeout(90_000),
          })
          const raw = await r.text()
          if (r.ok) {
            const answer = JSON.parse(raw)?.choices?.[0]?.message?.content || ''
            if (answer) return ok({ path, question: prompt, answer: truncate(answer, 6000), via: 'gemini-web-proxy' })
          }
          attempts.push(`gemini: HTTP ${r.status} ${truncate(raw, 200)}`)
        } catch (e) { attempts.push(`gemini: ${e.message}`) }
      }

      if (tryOpenAI) {
        try {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({
              model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
            }),
            signal: AbortSignal.timeout(90_000),
          })
          const raw = await r.text()
          if (r.ok) {
            const answer = JSON.parse(raw)?.choices?.[0]?.message?.content || ''
            if (answer) return ok({ path, question: prompt, answer: truncate(answer, 6000), via: 'openai' })
          }
          attempts.push(`openai: HTTP ${r.status} ${truncate(raw, 200)}`)
        } catch (e) { attempts.push(`openai: ${e.message}`) }
      }

      if (tryAnth) {
        try {
          // Anthropic expects base64 + media_type separately.
          const m = String(dataUrl).match(/^data:(image\/[a-z0-9+.-]+);base64,(.*)$/i)
          if (!m) throw new Error('data URL must be base64-encoded image')
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: process.env.ANTHROPIC_VISION_MODEL || 'claude-3-5-haiku-latest',
              max_tokens: 2000,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
                  { type: 'text', text: prompt },
                ],
              }],
            }),
            signal: AbortSignal.timeout(90_000),
          })
          const raw = await r.text()
          if (r.ok) {
            const j = JSON.parse(raw)
            const answer = j?.content?.map((b) => b.text || '').join('') || ''
            if (answer) return ok({ path, question: prompt, answer: truncate(answer, 6000), via: 'anthropic' })
          }
          attempts.push(`anthropic: HTTP ${r.status} ${truncate(raw, 200)}`)
        } catch (e) { attempts.push(`anthropic: ${e.message}`) }
      }

      return err(`No vision backend returned a usable answer. Attempts: ${attempts.join(' | ') || '(none configured)'}`)
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

  // ── Shell (sandboxed, persistent) ─────────────────────────────────────
  bash: {
    description:
      'Run a shell command inside an isolated Linux sandbox that has the workspace mounted at /workspace. By default uses a PERSISTENT session per chat — cd, env vars, exports, activated virtualenvs survive across calls (just like a real terminal). Pass persist:false to spawn a fresh one-shot shell (legacy behaviour). For long-running processes (dev server, watcher, tail -F) prefer bash_bg instead — it returns immediately and you read logs separately.',
    params: {
      command:     { type: 'string',  required: true,  description: 'Shell command, e.g. "ls -la /workspace" or "cd subdir && npm test"' },
      timeout_sec: { type: 'number',  optional: true,  description: 'Max seconds, default 60, max 300.' },
      persist:     { type: 'boolean', optional: true,  description: 'Default true — use the per-chat persistent session. Set false for a fresh one-shot shell.' },
    },
    handler: async ({ command, timeout_sec = 60, persist = true, _signal, _onStdout, _onStderr, _chatId } = {}) => {
      if (!command) return err('command is required')
      const timeoutMs = Math.min(300_000, Math.max(1_000, Number(timeout_sec) * 1000 || 60_000))
      try {
        if (persist && _chatId) {
          const { runInSession } = await import('./shellSession.js')
          const r = await runInSession({
            chatId: _chatId,
            command: String(command),
            timeoutMs,
            signal: _signal,
            onStdout: _onStdout,
            onStderr: _onStderr,
          })
          return ok({
            stdout: truncate(r.stdout || '', 6000),
            stderr: truncate(r.stderr || '', 3000),
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            persistent: true,
            cancelled: r.cancelled || false,
            killed: r.killed || false,
          })
        }
        const r = await runSandboxCommand({
          command: String(command),
          timeoutMs,
          signal: _signal,
          onStdout: _onStdout,
          onStderr: _onStderr,
        })
        return ok({
          stdout: truncate(r.stdout, 6000),
          stderr: truncate(r.stderr, 3000),
          exitCode: r.exitCode,
          persistent: false,
          truncated: r.truncated || false,
          cancelled: r.cancelled || false,
        })
      } catch (e) { return err(e.message) }
    },
  },

  bash_reset: {
    description: "Reset the chat's persistent shell session — useful if it's wedged or you want a clean env. The next bash call will reopen a fresh session.",
    params: {},
    handler: async ({ _chatId } = {}) => {
      if (!_chatId) return err('persistent session requires a chat scope')
      try {
        const { resetSession } = await import('./shellSession.js')
        const had = resetSession(_chatId)
        return ok({ reset: had, chatId: _chatId })
      } catch (e) { return err(e.message) }
    },
  },

  bash_bg: {
    description: 'Start a long-running command in the BACKGROUND. Returns a task id immediately. Use bash_logs <task_id> to inspect output, bash_stop <task_id> to kill it, bash_list to see what is running. Perfect for `npm run dev`, `tail -F app.log`, watchers, background servers.',
    params: {
      command: { type: 'string', required: true, description: 'Shell command to spawn in the background.' },
      name:    { type: 'string', optional: true, description: 'Human-readable label shown in bash_list (default: first 60 chars of command).' },
    },
    handler: async ({ command, name = '', _chatId = '' } = {}) => {
      if (!command) return err('command is required')
      try {
        const { startBackgroundTask } = await import('./shellSession.js')
        const t = startBackgroundTask({ chatId: _chatId, command: String(command), name })
        return ok({ taskId: t.taskId, name: t.name, command: t.command, startedAt: t.startedAt })
      } catch (e) { return err(e.message) }
    },
  },

  bash_logs: {
    description: 'Read the latest stdout+stderr of a background task started via bash_bg. Returns the tail ring buffer plus running/exitCode.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task id returned by bash_bg.' },
      tail:    { type: 'number', optional: true, description: 'Max chars per stream, default 4000.' },
    },
    handler: async ({ task_id, tail = 4000 } = {}) => {
      if (!task_id) return err('task_id is required')
      try {
        const { readBackgroundLogs } = await import('./shellSession.js')
        const r = readBackgroundLogs(task_id, { tail: Number(tail) || 4000 })
        if (!r) return err(`task not found: ${task_id}`)
        return ok(r)
      } catch (e) { return err(e.message) }
    },
  },

  bash_stop: {
    description: 'Stop a background task started via bash_bg. Sends SIGTERM, then SIGKILL after 1.5s.',
    params: { task_id: { type: 'string', required: true, description: 'Task id returned by bash_bg.' } },
    handler: async ({ task_id } = {}) => {
      if (!task_id) return err('task_id is required')
      try {
        const { stopBackgroundTask } = await import('./shellSession.js')
        const ok_ = stopBackgroundTask(task_id)
        return ok_ ? ok({ stopped: task_id }) : err(`task not found: ${task_id}`)
      } catch (e) { return err(e.message) }
    },
  },

  bash_list: {
    description: 'List background tasks for this chat (or all, if no chat scope). Shows id, name, running flag, exitCode, uptime.',
    params: { all_chats: { type: 'boolean', optional: true, description: 'Set true to list tasks across all chats (admin view).' } },
    handler: async ({ all_chats = false, _chatId = '' } = {}) => {
      try {
        const { listBackgroundTasks } = await import('./shellSession.js')
        const arr = listBackgroundTasks(all_chats ? null : (_chatId || null))
        return ok({ count: arr.length, tasks: arr })
      } catch (e) { return err(e.message) }
    },
  },

  // ── Verification: check code before deploying (mirrors the human-agent flow) ──
  verify_code: {
    description: 'Verify workspace code before committing/deploying. Runs lightweight checks in the sandbox: Node syntax check (node --check) on changed/!given JS files, optional npm script (e.g. lint/test/build), or a custom command. Use this BEFORE git_commit / ops deploy to avoid shipping broken code. Returns pass/fail per check.',
    params: {
      path: { type: 'string', optional: true, description: 'Repo/subfolder relative to workspace root. Empty = workspace root.' },
      node_check: { type: 'string', optional: true, description: 'File extension or filename pattern to run "node --check" on, searched recursively from path. Examples: "js" (all *.js), "*.mjs", "index.js". Fails if no files match.' },
      npm_script: { type: 'string', optional: true, description: 'npm script to run, e.g. "lint", "test", "build". Runs "npm run <script>" if present in package.json.' },
      command: { type: 'string', optional: true, description: 'Custom verification shell command to run instead of/in addition to the above.' },
      timeout_sec: { type: 'number', optional: true, description: 'Max seconds for the whole verification, default 120, max 600.' },
    },
    handler: async ({ path = '', node_check = '', npm_script = '', command = '', timeout_sec = 120 } = {}) => {
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

      if (node_check) {
        // Normalise the pattern into a find -name pattern (recursive).
        // "js" -> "*.js", "*.mjs" stays, "index.js" stays. Strip quotes/slashes
        // to keep it a safe single -name token (no path traversal / injection).
        let pat = String(node_check).replace(/['"`$;|&<>(){}\\]/g, '').trim()
        if (!pat) pat = '*.js'
        else if (/^[a-z0-9]+$/i.test(pat)) pat = `*.${pat}`        // "js" -> "*.js"
        else pat = pat.replace(/^.*\//, '')                        // keep basename pattern only
        // find recursively; FAIL the check if zero files matched (a verify tool
        // must never report "all good" when it verified nothing).
        const cmd = `found=0; fail=0; for f in $(find . -type f -name '${pat}' 2>/dev/null); do found=$((found+1)); if node --check "$f" 2>&1; then echo "ok: $f"; else echo "FAIL: $f"; fail=1; fi; done; echo "checked $found file(s) matching ${pat}"; if [ "$found" -eq 0 ]; then echo "ERROR: no files matched '${pat}'"; exit 2; fi; exit $fail`
        await runOne(`node --check ${pat}`, cmd)
      }
      if (npm_script) {
        const s = String(npm_script).replace(/[^a-zA-Z0-9:_-]/g, '')
        await runOne(`npm run ${s}`, `test -f package.json && npm run ${s} --if-present 2>&1 || echo "no package.json"`)
      }
      if (command) {
        await runOne('custom', String(command))
      }

      if (checks.length === 0) {
        return err('Nothing to verify — provide node_check, npm_script, or command')
      }
      const allPassed = checks.every((c) => c.passed)
      return ok({ allPassed, checks })
    },
  },
}

// Register use_subagents lazily on first read of TOOLS — avoids the
// circular dep with subAgents.js (which imports invokeTool from this
// file). Done by patching the TOOLS object after a microtask so that
// our own module finishes loading first.
//
// IMPORTANT: do NOT use top-level await here. It deadlocks Node ESM
// because subAgents.js -> agentTools.js (this file) -> top-level await
// on subAgents.js again. Production observed:
//   "Warning: Detected unsettled top-level await at agentTools.js:1083"
// and the container never reached app.listen().
import('./subAgents.js')
  .then(({ USE_SUBAGENTS_TOOL }) => {
    if (USE_SUBAGENTS_TOOL && !TOOLS.use_subagents) {
      TOOLS.use_subagents = USE_SUBAGENTS_TOOL
    }
  })
  .catch((e) => console.warn('[agentTools] use_subagents registration failed:', e?.message || e))

// ── Schema for the system prompt ────────────────────────────────────────────
/**
 * Render a tool catalogue (built-in TOOLS plus any extra map of
 * user-defined custom tools) as plain text the LLM can read.
 */
export function renderToolsForPrompt(extraTools = null) {
  const combined = extraTools && typeof extraTools === 'object'
    ? { ...TOOLS, ...extraTools }
    : TOOLS
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

/**
 * Invoke a tool by name. Returns the {ok, result|error} shape.
 * Pass `extraTools` to expose user-defined tools alongside the built-ins.
 */
export async function invokeTool(name, args = {}, { signal, onStdout, onStderr, userId, chatId, extraTools } = {}) {
  // MCP tools route through mcpClient — they don't live in TOOLS.
  if (typeof name === 'string' && name.startsWith('mcp__')) {
    try {
      const { invokeMcpTool } = await import('./mcpClient.js')
      const cleanArgs = { ...(args || {}) }
      delete cleanArgs._signal; delete cleanArgs._onStdout; delete cleanArgs._onStderr; delete cleanArgs._userId
      const out = await invokeMcpTool(name, cleanArgs)
      return ok(typeof out === 'string' ? out : (out ?? ''))
    } catch (e) { return err(`MCP ${name}: ${e?.message || String(e)}`) }
  }
  const tool = (extraTools && extraTools[name]) || TOOLS[name]
  if (!tool) return err(`Unknown tool: ${name}`)
  if (typeof tool.handler !== 'function') return err(`Tool ${name} has no handler`)
  // Cooperative cancellation + live-progress streaming + identity. Tools
  // that care pick up _signal / _onStdout / _onStderr / _userId from
  // their args; the rest just ignore the extra fields.
  const enrichedArgs = { ...(args || {}) }
  if (signal)   enrichedArgs._signal   = signal
  if (onStdout) enrichedArgs._onStdout = onStdout
  if (onStderr) enrichedArgs._onStderr = onStderr
  if (userId)   enrichedArgs._userId   = userId
  if (chatId)   enrichedArgs._chatId   = chatId
  try {
    if (signal?.aborted) return err('cancelled')
    return await tool.handler(enrichedArgs)
  } catch (e) {
    if (signal?.aborted) return err('cancelled')
    return err(e?.message || String(e))
  }
}
