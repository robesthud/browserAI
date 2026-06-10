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
  getContainerWorkspaceRoot,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'
import { runSandboxCommand } from './agentSandbox.js'
import { listOpsServices, runOpsAction } from './ops.js'
import { browserOpen, browserScreenshot, browserClick, browserType, browserClose } from './browserTools.js'
import { upsertFact, forgetFact, listFacts } from './userMemory.js'
import { addDocument, deleteDocument, listDocuments, searchKnowledge } from './knowledgeBase.js'

// ── Utility ─────────────────────────────────────────────────────────────────
function stripAnsi(str) {
  // Removes standard ANSI color/control codes which clutter LLM context
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
}

function truncate(str, max = 8000) {
  const s = stripAnsi(String(str ?? ''))
  if (s.length <= max) return s
  const head = Math.floor(max * 0.3) // 30% from the start
  const tail = Math.floor(max * 0.7) // 70% from the end (usually where the error is)
  return s.slice(0, head) + `\n\n... [truncated, ${s.length - max} more chars] ...\n\n` + s.slice(-tail)
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
  const root = getContainerWorkspaceRoot()
  return raw ? `${root}/${raw}` : root
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

// ── Fuzzy text matching for edit_file ─────────────────────────────────────
//
// Mirrors Arena-style edit behaviour: first try an EXACT substring match;
// if that fails, try matching after normalising runs of whitespace and
// per-line indentation. Returns { start, end, kind } where kind ∈
// { 'exact', 'whitespace', 'trim-lines' }. start/end are indexes into
// the ORIGINAL source (not the normalised form) so the slice/replace
// arithmetic in edit_file works cleanly.
function fuzzyFindMatch(haystack, needle) {
  if (!haystack || !needle) return null
  // 1. Exact match (cheap fast path).
  const ex = haystack.indexOf(needle)
  if (ex !== -1) return { start: ex, end: ex + needle.length, kind: 'exact' }

  // 2. Whitespace-normalised match — collapse any run of \s+ in the needle
  //    to a single \s+ regex, escape everything else.
  try {
    const pattern = needle
      .split(/\s+/)
      .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter(Boolean)
      .join('\\s+')
    if (pattern) {
      const re = new RegExp(pattern, 'm')
      const m = re.exec(haystack)
      if (m) return { start: m.index, end: m.index + m[0].length, kind: 'whitespace' }
    }
  } catch { /* ignore regex build failure */ }

  // 3. Per-line indentation-tolerant match — match the needle ignoring
  //    leading whitespace on every line independently. Useful when the
  //    LLM forgot 2 spaces of indent but otherwise wrote a perfect block.
  try {
    const needleLines = String(needle).split('\n').map((l) => l.replace(/^\s+/, ''))
    if (needleLines.length >= 2) {
      const escaped = needleLines.map((l) =>
        l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const pattern = escaped.join('\\n[ \\t]*')
      const re = new RegExp('[ \\t]*' + pattern, 'm')
      const m = re.exec(haystack)
      if (m) return { start: m.index, end: m.index + m[0].length, kind: 'trim-lines' }
    }
  } catch { /* ignore */ }

  return null
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
        if (path && path !== '.' && path !== '/') {
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
    description:
      'Read a file from the workspace. Text files return their content. Images (jpg, png, webp, gif, bmp) return as visible content. Other binary types return metadata only.',
    params: {
      path: { type: 'string', required: true, description: "Relative file path in the workspace (e.g., 'notes.txt', 'src/app.js', 'images/dog.jpg')" },
    },
    handler: async ({ path } = {}) => {
      if (!path) return err('path is required')
      try {
        const file = await readWorkspaceFile(path)
        const mime = file?.mime || ''
        // Image: surface base64 + dataUrl so the LLM (vision) and the UI
        // can both see it without a separate analyze_image call.
        if (/^image\//i.test(mime) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(path)) {
          // readWorkspaceFile returns either `text` (decoded), `content`
          // (utf8 sample of binary) or a buffer-like field. We re-fetch
          // bytes from disk to get the binary unchanged.
          let dataUrl = ''
          let bytes = 0
          try {
            const { readFile } = await import('node:fs/promises')
            const path_ = await import('node:path')
            const ws = await import('./workspace.js')
            const safe = ws.default?.safePath || ws.safePath
            const abs = typeof safe === 'function'
              ? safe(path)
              : path_.join(process.env.WORKSPACE_ROOT || '/workspace', path)
            const buf = await readFile(abs)
            bytes = buf.length
            dataUrl = `data:${mime || 'image/png'};base64,${buf.toString('base64')}`
          } catch { /* fall back to whatever readWorkspaceFile gave us */ }
          return ok({
            path,
            mime,
            kind: 'image',
            bytes,
            // Visible content for the chat — UI renders the image inline.
            dataUrl,
            // Hint for the LLM observation when the provider isn't vision-capable.
            note: dataUrl ? 'Image attached; vision-capable models will see it inline.' : 'Image present but not readable as bytes.',
          })
        }
        if (!file?.text && !file?.content) {
          // Other binary file — still useful to acknowledge its presence.
          return ok({
            path,
            mime,
            kind: 'binary',
            bytes: file?.size || 0,
            note: 'Binary file — content not extracted. Use download_url or a specialised tool.',
          })
        }
        return ok({ path, content: truncate(file.text ?? file.content, 20000), mime, kind: 'text' })
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
    description: 'Create or overwrite a file in the workspace. Provide the full file content.',
    params: {
      path: { type: 'string', required: true, description: "Relative file path in the workspace (e.g., 'notes.txt', 'src/app.js', 'data/events.csv')" },
      content: { type: 'string', required: true, description: 'The full file content to write' },
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
      'Edit a file by searching for existing text and replacing it. It uses fuzzy matching that tolerates whitespace and indentation differences.',
    params: {
      path: { type: 'string', required: true, description: "Relative file path in the workspace (e.g., 'notes.txt', 'src/app.js', 'index.html')" },
      old_text: { type: 'string', required: true, description: 'The text to find in the file. Uses fuzzy matching that tolerates whitespace and indentation differences. Only the first match is replaced.' },
      new_text: { type: 'string', required: true, description: 'The replacement text. Use an empty string to delete the matched text.' },
    },
    handler: async ({ path, file, old_text, new_text = '', edits } = {}) => {
      const filePath = path || file   // backward-compat alias
      if (!filePath) return err('path is required')
      try {
        const f = await readWorkspaceFile(filePath)
        const original = f?.text ?? f?.content
        if (typeof original !== 'string') return err(`File is binary or unreadable: ${filePath}`)

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
          const match = fuzzyFindMatch(current, o)
          if (!match) {
            return err(`edit #${i + 1}: old_text not found in ${filePath} (tried exact + fuzzy whitespace match)`)
          }
          current = current.slice(0, match.start) + n + current.slice(match.end)
          applied.push({
            idx: i + 1,
            deltaBytes: n.length - (match.end - match.start),
            matchStart: match.start,
            matchKind: match.kind,
          })
        }
        await writeFileContent(filePath, current)
        const diagnostics = await quickSyntaxCheck(filePath, current)
        return ok({
          path: filePath,
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
        const projects = collectProjectsFromTree(tree)
        const groundingNote = `POST-FETCH GROUNDING (CRITICAL): download_url succeeded. Files are NOW LOCAL in /workspace/${parentPath || ''}. 
Your root is /workspace. DO NOT use /workspace/chats/ID/ prefixes.
Linux is CASE-SENSITIVE. Use exact names from list_files.
State: local copy exists. 
You MUST immediately use ONLY workspace tools for analysis: list_files, find_projects (detected ${projects.length} projects), read_file, search_files, bash on local paths.
NEVER call download_url, git_clone, web_search or any remote tool on the original URL again unless user says "обнови" or "pull latest".
Tree snippet at destination: ${JSON.stringify(node).slice(0,800)}
Projects: ${JSON.stringify(projects.slice(0,5))}`
        return ok({
          url,
          destination: parentPath || '/',
          ...saved,
          tree: node,
          postFetchGrounding: groundingNote,
          localProjects: projects.slice(0,5),
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
      const gitResult = await runGit({
        path,
        command: `git clone --depth ${depthArg} ${shellQuote(url)}${nameArg} && find . -maxdepth 2 -type f | sed 's#^./##' | head -80`,
        timeout_sec: 120,
      })
      if (gitResult.ok) {
        const tree = await getWorkspaceTree(false)
        const projects = collectProjectsFromTree(tree)
        const groundingNote = `POST-FETCH GROUNDING (CRITICAL): git_clone succeeded for ${url}. Files are NOW LOCAL in /workspace. 
Your root is /workspace. DO NOT use /workspace/chats/ID/ prefixes.
Linux is CASE-SENSITIVE. Use exact names from list_files.
State: local copy exists (git history present). 
You MUST immediately use ONLY workspace tools: list_files, find_projects (detected ${projects.length} projects), read_file on local paths (package.json, README etc), search_files, bash (local).
NEVER re-call git_clone, download_url or remote tools on ${url} for "analyze", "проанализируй", "what is in the project".
Recent clone output: ${gitResult.result?.stdout?.slice(0,600) || ""}
Projects found: ${JSON.stringify(projects.slice(0,5))}`
        return ok({
          ...gitResult.result,
          postFetchGrounding: groundingNote,
          localProjects: projects.slice(0,5),
          url,
        })
      }
      return gitResult
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
    description:
      "Search the web for current information. Returns relevant results with titles, URLs, and content snippets. Use when you need facts, recent events, or information beyond your training data. When citing results, use the result's numeric id and url in this exact format: [id](url). For example, if a result has id=1 and url=https://example.com, cite it as [1](https://example.com). Do NOT use [source](url) or any other format. Every claim from search results must have a citation.",
    params: {
      query: { type: 'string', required: true, description: 'The search query' },
      depth: { type: 'string', required: true, description: 'The search tool accepts a depth parameter (1, 2, or 3) that controls how many results are fetched and how much content is extracted from each. At depth 1, fewer results are retrieved with shorter excerpts. At depth 3, more results are retrieved with longer, more detailed excerpts per source. Depth 2 falls between the two. Higher depth consumes more of the context window.' },
    },
    handler: async ({ query, depth = '2', limit } = {}) => {
      if (!query) return err('query is required')
      try {
        // Map my-style depth to a numeric limit. Caller can still pass
        // explicit `limit` to override (backward-compat).
        const depthToLimit = { '1': 3, '2': 6, '3': 10 }
        const cap = Number.isFinite(Number(limit))
          ? Number(limit)
          : depthToLimit[String(depth)] || 6
        const data = await searchWeb(String(query), Math.min(10, Math.max(1, cap)))
        // Tag every result with a stable numeric id so the model can
        // cite as [id](url) following my convention.
        const results = (data?.results || []).map((r, i) => ({ id: i + 1, ...r }))
        return ok({ query, depth: String(depth || '2'), results })
      } catch (e) { return err(e.message) }
    },
  },

  web_fetch: {
    description:
      'Retrieve the text content of a web page as markdown. Content may be returned in chunks. If hasMore is true, call again with the same url and the next chunkIndex to continue reading. PDFs are parsed up to 30 pages; content beyond that will not be returned.',
    params: {
      url:        { type: 'string', required: true, description: 'The URL of the page to fetch.' },
      chunkIndex: { type: 'number', optional: true, description: 'Which chunk to return (0-indexed). Omit or pass 0 for the first chunk. Default 0.' },
    },
    handler: async ({ url, chunkIndex = 0 } = {}) => {
      if (!url) return err('url is required')
      try {
        const page = await fetchWebPage(String(url))
        const full = String(page?.content || page?.text || '')
        const CHUNK = 12_000
        const idx = Math.max(0, Number(chunkIndex) || 0)
        const start = idx * CHUNK
        const end = Math.min(full.length, start + CHUNK)
        const slice = full.slice(start, end)
        const hasMore = end < full.length
        return ok({
          url,
          title: page?.title || '',
          chunkIndex: idx,
          totalChunks: Math.max(1, Math.ceil(full.length / CHUNK)),
          hasMore,
          content: slice,
        })
      } catch (e) { return err(e.message) }
    },
  },

  scrape_url: {
    description: 'Fetch a web page and extract specific text or attributes using CSS selectors. Useful for targeted extraction (e.g. prices, specific tables) without reading the entire markdown dump. Uses Cheerio internally.',
    params: {
      url: { type: 'string', required: true, description: 'The URL of the page to scrape.' },
      selector: { type: 'string', required: true, description: 'CSS selector (e.g., ".price", "table > tr:nth-child(2)").' },
      attribute: { type: 'string', optional: true, description: 'Extract a specific attribute (e.g. "href", "src"). If omitted, extracts the text content.' },
      limit: { type: 'number', optional: true, description: 'Max number of matching elements to return. Default 5, max 50.' },
    },
    handler: async ({ url, selector, attribute, limit = 5 } = {}) => {
      if (!url) return err('url is required')
      if (!selector) return err('selector is required')
      try {
        let cheerio;
        try {
          cheerio = await import('cheerio')
        } catch {
          return err('cheerio is not installed. Please run "npm install cheerio" in the workspace first.')
        }
        const r = await fetch(String(url), {
           headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrowserAI/1.0)' },
           signal: AbortSignal.timeout(15_000)
        })
        if (!r.ok) return err(`HTTP ${r.status}`)
        const html = await r.text()
        const $ = cheerio.load(html)
        const matches = []
        const safeLimit = Math.min(50, Math.max(1, Number(limit) || 5))
        $(String(selector)).slice(0, safeLimit).each((_, el) => {
          if (attribute) {
            matches.push($(el).attr(String(attribute)) || '')
          } else {
            matches.push($(el).text().replace(/\\s+/g, ' ').trim())
          }
        })
        return ok({ url, selector, count: matches.length, matches: matches.filter(Boolean) })
      } catch (e) { return err(e.message) }
    },
  },

  // Alias of web_fetch following my own naming. Same behaviour, same params,
  // present so models trained on Arena-style names find it.
  fetch_page: {
    description: 'Retrieve the text content of a web page as markdown. Content may be returned in chunks. If hasMore is true, call again with the same url and the next chunkIndex. PDFs are parsed up to 30 pages; content beyond that won\'t be returned.',
    params: {
      url:        { type: 'string', required: true, description: 'The URL of the page to fetch.' },
      chunkIndex: { type: 'number', optional: true, description: 'Which chunk to return (0-indexed). Omit or pass 0 for the first chunk.' },
    },
    handler: async (args = {}) => TOOLS.web_fetch.handler(args),
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
      'Tries (in order): (1) any vision-capable key stored in the DB, (2) OPENAI_API_KEY env, (3) ANTHROPIC_API_KEY env. ' +
      'Use this for screenshots from browser_open / computer_screenshot, diagrams, user-attached photos, etc.',
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

      // Discover vision-capable keys stored in the DB. We treat keys
      // whose model name matches gemini/gpt-4o/claude-*-sonnet|opus|haiku
      // as eligible. Anything else is a text-only LLM and we skip it.
      let dbKeys = []
      try {
        const dbModule = await import('./db.js')
        const dbHandle = dbModule.default
        const rows = dbHandle.prepare("SELECT base_url, api_key, model, auth_type FROM keys").all()
        dbKeys = rows.filter((r) => /gemini|gpt-4o|claude/i.test(String(r.model || '')))
      } catch (e) {
        attempts.push(`db lookup failed: ${e.message}`)
      }

      // 1. DB-stored vision-capable provider (typically the user's own
      //    Google AI Studio / OpenAI / Anthropic key).
      for (const k of dbKeys) {
        if (want && !String(k.model).toLowerCase().includes(want)) continue
        try {
          const url = String(k.base_url || '').replace(/\/$/, '')
          if (!url) continue
          const r = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k.api_key}` },
            body: JSON.stringify({
              model: k.model,
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
            }),
            signal: AbortSignal.timeout(90_000),
          })
          const raw = await r.text()
          if (r.ok) {
            const answer = JSON.parse(raw)?.choices?.[0]?.message?.content || ''
            if (answer) return ok({ path, question: prompt, answer: truncate(answer, 6000), via: `db:${k.model}` })
          }
          attempts.push(`db ${k.model}: HTTP ${r.status} ${truncate(raw, 150)}`)
        } catch (e) { attempts.push(`db ${k.model}: ${e.message}`) }
      }

      const tryOpenAI = (!want || want === 'openai') && process.env.OPENAI_API_KEY
      const tryAnth   = (!want || want === 'anthropic') && process.env.ANTHROPIC_API_KEY

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
    description:
      'Surfaces an UI component to the user to ask clarifying questions. Use this ONLY as a LAST RESORT. Do NOT use it if you can infer the answer by exploring the workspace (e.g. via list_files, read_file, or bash). Each question supports 2-4 predefined options plus an optional free-text input.',
    params: {
      questions: { type: 'array', required: true, description: 'List of questions to ask the user. Try to keep this to 4 or fewer questions. Items have {id, question, options:[{id, label, description}], allowCustomResponse}.' },
    },
    // Placeholder handler — the agent loop short-circuits this tool and
    // resolves it via askUserRegistry. Kept so the schema validates and
    // so a stray ask_user invocation from outside the loop doesn't error.
    handler: async () => ok({ pending: true }),
  },

  // ── Shell (sandboxed, persistent) ─────────────────────────────────────
  bash: {
    description:
      'Run a bash command in the sandboxed workspace. Commands run in the provided cwd, defaulting to /workspace, without a controlling terminal and with stdin closed. IMPORTANT: Interactive commands will hang until timeout! Always use non-interactive flags (e.g. apt-get install -y, npm init -y). Working directory changes, exported environment variables, and background process state ARE PRESERVED across calls by default (persist=true) using a per-chat persistent shell session. Long-running commands (servers) MUST be run using bash_bg, otherwise this tool will block.',
    params: {
      command: { type: 'string',  required: true, description: 'The bash command to execute.' },
      cwd:     { type: 'string',  optional: true, description: 'Working directory for this command. Defaults to /workspace.' },
      timeout: { type: 'number',  optional: true, description: 'Maximum seconds before the command is terminated. Default 120, max 1800.' },
      persist: { type: 'boolean', optional: true, description: 'Default true — use the per-chat persistent session. Set false for a fresh one-shot shell.' },
    },
    handler: async (args = {}) => {
      let { command, cwd, timeout, timeout_sec, persist = true, _signal, _onStdout, _onStderr, _chatId } = args
      if (!cwd) cwd = getContainerWorkspaceRoot()
      if (!command) return err('command is required')
      const rawSecs = Number(timeout ?? timeout_sec ?? 120)
      const timeoutMs = Math.min(1_800_000, Math.max(1_000, (Number.isFinite(rawSecs) ? rawSecs : 120) * 1000))
      try {
        // For persistent sessions cwd is enforced via a 'cd' prefix so the
        // session's own cwd doesn't get clobbered (a bare `cd /tmp && cmd`
        // would still leave the session in /tmp afterwards if the user
        // intended otherwise). For one-shot we pass it to the sandbox as
        // its working directory directly.
        if (persist && _chatId) {
          const { runInSession } = await import('./shellSession.js')
          const wrappedCommand = (cwd && cwd !== getContainerWorkspaceRoot())
            ? `( cd ${JSON.stringify(cwd)} && ${command} )`
            : String(command)
          const r = await runInSession({
            chatId: _chatId,
            command: wrappedCommand,
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
            cwd,
            cancelled: r.cancelled || false,
            killed: r.killed || false,
          })
        }
        const r = await runSandboxCommand({
          command: String(command),
          cwd: cwd || '/workspace',
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
          cwd: cwd || getContainerWorkspaceRoot(),
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

  run_python_with_plot: {
    description: 'Execute a Python script that generates a plot/chart (e.g. using matplotlib, seaborn) and returns the generated image directly to the chat so the user can see it. The script must save the output to "/tmp/plot.png". Automatically installs requested pip packages.',
    params: {
      code: { type: 'string', required: true, description: 'Python code to execute. MUST end by saving a figure to "/tmp/plot.png".' },
      packages: { type: 'array', optional: true, description: 'Array of pip packages to install before running (e.g. ["matplotlib", "pandas", "seaborn"]).' },
    },
    handler: async ({ code, packages = [] } = {}) => {
      if (!code) return err('code is required')
      if (!code.includes('/tmp/plot.png')) return err('Your code must save the figure to "/tmp/plot.png" (e.g. plt.savefig("/tmp/plot.png"))')
      
      try {
        let setupCmd = 'python3 -m venv /tmp/venv && . /tmp/venv/bin/activate && '
        if (Array.isArray(packages) && packages.length > 0) {
          setupCmd += `pip install --quiet --no-cache-dir ${packages.map(p => String(p).replace(/[^a-zA-Z0-9_-]/g, '')).join(' ')} && `
        }
        
        const scriptStr = String(code).replace(/'/g, "'\\''")
        const fullCmd = `${setupCmd} python -c '${scriptStr}' && base64 -w0 /tmp/plot.png`
        
        const r = await runSandboxCommand({
          command: fullCmd,
          cwd: '/workspace',
          timeoutMs: 60_000,
        })
        
        if (r.exitCode !== 0) {
          return err(`Execution failed: ${r.stderr || r.stdout || 'unknown error'}`)
        }
        
        const lines = String(r.stdout || '').trim().split('\n')
        const b64 = lines[lines.length - 1]
        if (!b64 || b64.length < 100) return err('Could not extract base64 PNG from output. Make sure you saved to /tmp/plot.png')
        
        return ok({
          dataUrl: `data:image/png;base64,${b64}`,
          message: 'Plot generated successfully!'
        })
      } catch (e) {
        return err(e.message)
      }
    }
  },

  bash_bg: {
    description: 'Start a long-running command in the BACKGROUND. Returns a task id immediately. Use bash_logs <task_id> to inspect output, bash_stop <task_id> to kill it, bash_list to see what is running. Perfect for `npm run dev`, `tail -F app.log`, watchers, background servers.',
    params: {
      command: { type: 'string', required: true, description: 'Shell command to spawn in the background.' },
      name:    { type: 'string', optional: true, description: 'Human-readable label shown in bash_list (default: first 60 chars of command).' },
    },
    handler: async (args = {}) => {
      let { command, name = '', _chatId = '' } = args
      if (!command) return err('command is required')
      try {
        const { startBackgroundTask } = await import('./shellSession.js')
        const t = startBackgroundTask({ chatId: _chatId, command: String(command), name, cwd: getContainerWorkspaceRoot() })
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

  // ── Image generation (Arena-style: file_path + prompt) ────────────────
  // Mirrors my generate_image signature. Submits a job to the local
  // Generate an image from a text prompt via Google's official
  // generativelanguage.googleapis.com API (no headless browser, no
  // proxy). Auto-discovers a Google API key in either:
  //   • env GEMINI_API_KEY / GOOGLE_API_KEY
  //   • a key row in the DB whose base_url contains 'googleapis.com'
  //     OR whose api_key starts with 'AIza' (the Google API key shape).
  // If no key is found, returns a clear error pointing the user at
  // https://aistudio.google.com/apikey (free, no billing required).
  generate_image: {
    description:
      'Generate an image from a text prompt and save it to the workspace. The image is saved to the specified file path, which must end in .jpg, .jpeg, or .png. Use when the user requests an image, illustration, icon, or visual asset. The generated image will be visible in the workspace preview.',
    params: {
      file_path: { type: 'string', required: true, description: "Relative path to save the generated image (e.g., 'images/hero.jpg', 'logo.png'). Must end in .jpg, .jpeg, or .png." },
      prompt:    { type: 'string', required: true, description: 'Text prompt describing the image to generate' },
    },
    handler: async ({ file_path, prompt, _signal } = {}) => {
      if (!file_path) return err('file_path is required')
      if (!prompt)    return err('prompt is required')
      if (!/\.(jpe?g|png)$/i.test(file_path)) {
        return err('file_path must end in .jpg, .jpeg, or .png')
      }

      // Discover a Google API key.
      let apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
      if (!apiKey) {
        try {
          const dbModule = await import('./db.js')
          const rows = dbModule.default.prepare(
            "SELECT api_key, model FROM keys WHERE base_url LIKE '%googleapis.com%' OR api_key LIKE 'AIza%' LIMIT 1"
          ).all()
          if (rows.length) apiKey = rows[0].api_key
        } catch { /* fall through */ }
      }
      if (!apiKey) {
        return err(
          'Нет Google API key. Получи бесплатный на https://aistudio.google.com/apikey (без карты, 100 картинок/день) ' +
          'и добавь его в Settings → API Keys с base_url https://generativelanguage.googleapis.com/v1beta/openai/'
        )
      }

      const targetModel = model || 'gemini-2.5-flash-image-preview'
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent`
      try {
        const r = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: String(prompt) }] }],
            generationConfig: { responseModalities: ['Image'] },
          }),
          signal: _signal || AbortSignal.timeout(120_000),
        })
        const text = await r.text()
        if (!r.ok) {
          return err(`Google API HTTP ${r.status}: ${truncate(text, 400)}`)
        }
        let data
        try { data = JSON.parse(text) } catch { return err(`Google API returned non-JSON: ${truncate(text, 200)}`) }

        // Find image bytes in response — Google returns them under
        // candidates[0].content.parts[*].inlineData.data (base64).
        let b64 = ''
        let mime = 'image/png'
        const parts = data?.candidates?.[0]?.content?.parts || []
        for (const p of parts) {
          if (p?.inlineData?.data) {
            b64 = p.inlineData.data
            mime = p.inlineData.mimeType || mime
            break
          }
        }
        if (!b64) {
          const finishReason = data?.candidates?.[0]?.finishReason || 'unknown'
          const promptFeedback = data?.promptFeedback ? JSON.stringify(data.promptFeedback) : ''
          return err(`Google API returned no image (finish=${finishReason}). ${promptFeedback}`.trim())
        }

        // Save to workspace.
        const { writeFile, mkdir } = await import('node:fs/promises')
        const pathMod = await import('node:path')
        const ws = await import('./workspace.js')
        const safe = ws.default?.safePath || ws.safePath
        const destAbs = typeof safe === 'function'
          ? safe(file_path)
          : pathMod.join(process.env.WORKSPACE_ROOT || '/workspace', file_path)
        await mkdir(pathMod.dirname(destAbs), { recursive: true })
        const buf = Buffer.from(b64, 'base64')
        await writeFile(destAbs, buf)

        return ok({
          file_path,
          bytes: buf.length,
          mime,
          model: targetModel,
          via: 'google-ai-studio',
          dataUrl: `data:${mime};base64,${b64}`,    // inline preview in chat
          note: 'Image saved to workspace and shown inline.',
        })
      } catch (e) {
        return err(`generate_image: ${e?.message || String(e)}`)
      }
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

// ── Computer Use tools (Claude-style; opt-in) ─────────────────────────────
//
// Registered only when BROWSERAI_COMPUTER_USE=on AND
// computer-sandbox container is reachable. Otherwise the tool list
// stays clean and the LLM never tries to call them.
//
// Each tool returns a {dataUrl} that the AgentToolBlock UI renders as
// an inline screenshot, so the chat shows the screen state after every
// action — same UX as Claude's Computer Use reference implementation.
if (String(process.env.BROWSERAI_COMPUTER_USE || '').toLowerCase() === 'on') {
  import('./computerUse.js')
    .then(({
      computerScreenshot, computerClick, computerDoubleClick, computerMove,
      computerScroll, computerType, computerKey, computerOpenApp, computerStatus,
    }) => {
      const wrap = (fn) => async (args = {}) => {
        try {
          const r = await fn({ ...(args || {}), signal: args._signal })
          return r?.ok === false ? err(r.error || 'computer tool failed') : ok(r)
        } catch (e) { return err(e?.message || String(e)) }
      }
      TOOLS.computer_screenshot = {
        description: 'Take a screenshot of the virtual desktop. Returns a PNG data URL the model can SEE. Use as the first step of any Computer Use sequence so you know what the screen currently shows.',
        params: {},
        handler: wrap(computerScreenshot),
      }
      TOOLS.computer_click = {
        description: 'Click the mouse at pixel coordinates (x, y) on the virtual desktop. The screen is 1280x720 by default. Returns a fresh screenshot showing the result.',
        params: {
          x:      { type: 'number', required: true, description: 'X pixel coordinate (0..screen_width).' },
          y:      { type: 'number', required: true, description: 'Y pixel coordinate (0..screen_height).' },
          button: { type: 'string', optional: true, description: '"left" (default), "middle", "right".' },
        },
        handler: wrap(computerClick),
      }
      TOOLS.computer_double_click = {
        description: 'Double-click at (x, y).',
        params: {
          x: { type: 'number', required: true, description: 'X pixel coordinate.' },
          y: { type: 'number', required: true, description: 'Y pixel coordinate.' },
        },
        handler: wrap(computerDoubleClick),
      }
      TOOLS.computer_move = {
        description: 'Move the mouse to (x, y) without clicking (useful for hover effects). Does NOT return a screenshot — call computer_screenshot afterwards if needed.',
        params: {
          x: { type: 'number', required: true, description: 'X pixel coordinate.' },
          y: { type: 'number', required: true, description: 'Y pixel coordinate.' },
        },
        handler: wrap(computerMove),
      }
      TOOLS.computer_scroll = {
        description: 'Scroll the mouse wheel at (x, y) — useful for long pages / lists. Direction is "up" or "down"; amount = number of wheel ticks (default 3).',
        params: {
          x:         { type: 'number', optional: true, description: 'X coordinate to move mouse to first (optional).' },
          y:         { type: 'number', optional: true, description: 'Y coordinate.' },
          direction: { type: 'string', optional: true, description: '"up" or "down" (default "down").' },
          amount:    { type: 'number', optional: true, description: 'Number of wheel ticks. Default 3, max 20.' },
        },
        handler: wrap(computerScroll),
      }
      TOOLS.computer_type = {
        description: 'Type a literal string of text into the currently-focused element on the virtual desktop. Use computer_key for special keys (Return, Tab, Escape, ctrl+l, …).',
        params: {
          text: { type: 'string', required: true, description: 'Text to type. Up to 5000 characters. Plain text only — special keys via computer_key.' },
        },
        handler: wrap(computerType),
      }
      TOOLS.computer_key = {
        description: 'Press a key or key combination on the virtual desktop. Uses X11 keysym names: Return, BackSpace, Tab, Escape, Page_Down, Home, ctrl+a, ctrl+l, ctrl+shift+t, alt+F4, etc.',
        params: {
          key: { type: 'string', required: true, description: 'Key name. Examples: "Return", "Escape", "ctrl+l", "alt+Tab".' },
        },
        handler: wrap(computerKey),
      }
      TOOLS.computer_open_app = {
        description: 'Spawn an application on the virtual desktop. Currently allowed: "firefox" (with optional url), "xterm". Returns a screenshot after the window has rendered.',
        params: {
          name: { type: 'string', optional: true, description: '"firefox" (default) or "xterm".' },
          url:  { type: 'string', optional: true, description: 'Initial URL for firefox (http/https only).' },
        },
        handler: wrap(computerOpenApp),
      }
      TOOLS.computer_status = {
        description: 'Diagnostic: returns whether the virtual desktop is up and the current mouse / window state. Use this BEFORE the first screenshot to confirm computer-sandbox is reachable.',
        params: {},
        handler: wrap(computerStatus),
      }
      console.log(`[agentTools] Computer Use enabled (${Object.keys(TOOLS).filter((k) => k.startsWith('computer_')).length} tools)`)
    })
    .catch((e) => console.warn('[agentTools] Computer Use registration failed:', e?.message || e))
}

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
