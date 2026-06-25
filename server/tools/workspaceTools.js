import {
  ok, err, truncate, shQuote, scopedContainerRoot, rewriteWorkspacePaths, runWorkspaceCommand, defaultCloneDir, addPathToZip, isCodeLikePath, ensureParentDirs,
  getWorkspaceTree, readWorkspaceFile, createFile, createFolder, writeFileContent, renameItem, deleteItem, searchWorkspaceContent, getContainerWorkspaceRoot, safePath, makeAgentWritable,
  searchWeb, fetchWebPage, runSandboxCommand, upsertFact, forgetFact, listFacts, addDocument, deleteDocument, listDocuments, searchKnowledge, fetchViaProxy, isGoogleGenerativeNativeUrl, callLLM, getActiveKeyDecrypted,
  fsWriteFile, fsReadFile, fsMkdir, fsReaddir, fsStat,
  browserOpen, browserScreenshot, browserClick, browserType, browserClose,
  computerScreenshot, computerClick, computerType, computerOpenApp, computerStatus,
  listOpsServices, runOpsAction, buildProjectProfile, buildVerificationPlan, scanSecrets,
  createWorkspaceSnapshot, listWorkspaceSnapshots, restoreWorkspaceSnapshot,
  runInSession, resetSession, startBackgroundTask, readBackgroundLogs, stopBackgroundTask, listBackgroundTasks, detectWorkspaceChangesAround, createUnifiedDiff,
  PRIVILEGED_TOOLS, AdmZip, path
} from './helpers.js'


function fuzzyReplace(original, oldText, newText) {
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const origNorm = norm(original)
  const oldNorm = norm(oldText)
  const newNorm = norm(newText)

  if (origNorm.includes(oldNorm)) {
    const exactCount = origNorm.split(oldNorm).length - 1
    if (exactCount === 1) {
      return origNorm.replace(oldNorm, () => newNorm)
    }
    return { error: `old_text found ${exactCount} times (exact match). Make old_text more specific so it matches only once.` }
  }

  const origLines = original.split(/\r?\n/)
  const oldLines = oldText.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (oldLines.length === 0) return { error: 'old_text is empty after trimming — nothing to replace.' }

  let matchStart = -1
  let matchCount = 0

  for (let i = 0; i <= origLines.length - oldLines.length; i++) {
    let matches = true
    for (let j = 0; j < oldLines.length; j++) {
      if (origLines[i + j].trim() !== oldLines[j]) {
        matches = false
        break
      }
    }
    if (matches) {
      matchCount++
      matchStart = i
    }
  }

  if (matchCount === 1) {
    const before = origLines.slice(0, matchStart).join('\n')
    const after = origLines.slice(matchStart + oldLines.length).join('\n')
    return (before ? before + '\n' : '') + newNorm + (after ? '\n' + after : '')
  }

  if (matchCount > 1) {
    return { error: `old_text matched ${matchCount} locations (fuzzy). Make old_text more specific so it matches only once.` }
  }

  return { error: 'old_text not found — neither exact nor fuzzy match succeeded. Read the file again and use a substring that exactly exists.' }
}


export const workspaceTools = {
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
    description: 'Read a text file from the workspace. Supports reading specific line ranges to stay within context limits.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root.' },
      start_line: { type: 'number', optional: true, description: 'Line to start reading from (1-indexed).' },
      end_line: { type: 'number', optional: true, description: 'Line to stop reading at (inclusive).' },
    },
    handler: async ({ path, start_line, end_line } = {}) => {
      if (!path) return err('path is required')
      try {
        const file = await readWorkspaceFile(path)
        const text = file?.text ?? file?.content
        if (typeof text !== 'string') return err(`File is binary or empty: ${path}`)
        
        const lines = text.split(/\r?\n/)
        const total = lines.length
        
        let start = Math.max(1, Number(start_line) || 1)
        let end = Math.min(total, Number(end_line) || total)
        
        // Auto-truncate huge files if no range given
        if (!start_line && !end_line && text.length > 30000) {
          end = 500
        }

        if (start > end) {
          return err(`start_line (${start}) is greater than end_line (${end}). Check your line range.`)
        }

        const selection = lines.slice(start - 1, end)
        const content = selection.map((line, i) => `${(start + i).toString().padStart(4, ' ')} | ${line}`).join('\n')
        
        return ok({ 
          path, 
          total_lines: total,
          start_line: start,
          end_line: end,
          content,
          mime: file.mime,
          hint: end < total ? `File truncated. Use read_file with start_line=${end + 1} to read more.` : null
        })
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
    handler: async ({ path, content } = {}) => {
      if (!path) return err('path is required')
      // Явная проверка: content=null → пустая строка (не строка "null")
      const safeContent = (content == null) ? '' : String(content)
      try {
        let previousText = null
        try {
          const previous = await readWorkspaceFile(path)
          previousText = typeof previous?.text === 'string' ? previous.text : null
        } catch { /* file may not exist yet */ }
        await ensureParentDirs(path)
        const parts = String(path).split('/').filter(Boolean)
        const name = parts.pop()
        if (!name) return err('Invalid path: cannot write to root or empty path')
        const parent = parts.join('/')
        try {
          await createFile(parent, name, safeContent)
        } catch {
          await writeFileContent(path, safeContent)
        }
        const diff = createUnifiedDiff({ path, before: previousText || '', after: safeContent, type: previousText == null ? 'created' : 'modified' })
        const codeLike = isCodeLikePath(path)
        return ok({ path, bytes: Buffer.byteLength(safeContent, 'utf8'), diffPreview: diff, changedFiles: { created: previousText == null ? [path] : [], modified: previousText == null ? [] : [path], deleted: [], all: [path], code: codeLike ? [path] : [], diffs: [diff], diffCount: 1, total: 1, codeChanged: codeLike }, hint: 'Call verify_code next to check syntax.' })
      } catch (e) { return err(e.message) }
    },
  },

  edit_file: {
    description: 'Replace a specific substring or block of lines inside an existing file. Tolerates spacing, indentation, and carriage return differences.',
    params: {
      path: { type: 'string', required: true, description: 'Path relative to workspace root.' },
      old_text: { type: 'string', required: true, description: 'Substring or block of lines to find. Tolerates slight formatting differences.' },
      new_text: { type: 'string', required: true, description: 'Replacement text. Use empty string to delete.' },
    },
    handler: async ({ path, old_text, new_text = '' } = {}) => {
      if (!path || old_text == null) return err('path and old_text are required')
      try {
        const file = await readWorkspaceFile(path)
        const original = file?.text ?? file?.content
        if (typeof original !== 'string') return err(`File is binary or unreadable: ${path}`)
        
        const updated = fuzzyReplace(original, old_text, new_text)
        if (updated && typeof updated === 'object' && updated.error) {
          return err(`edit_file failed on ${path}: ${updated.error}`)
        }
        if (typeof updated !== 'string') {
          return err(`edit_file: unexpected result type for ${path}`)
        }
        
        await writeFileContent(path, updated)
        const diff = createUnifiedDiff({ path, before: original, after: updated, type: 'modified' })
        const codeLike = isCodeLikePath(path)
        return ok({ path, replaced: 1, newLength: updated.length, diffPreview: diff, changedFiles: { created: [], modified: [path], deleted: [], all: [path], code: codeLike ? [path] : [], diffs: [diff], diffCount: 1, total: 1, codeChanged: codeLike }, hint: 'Call verify_code next to check syntax.' })
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

  zip_files: {
    description: 'Create a ZIP archive from files/folders in the current chat workspace. Use this when the user asks to zip/archive/package downloaded files.',
    params: {
      source_path: { type: 'string', optional: true, description: 'File/folder to archive, relative to workspace root. Empty = whole chat workspace.' },
      output_path: { type: 'string', optional: true, description: 'ZIP file path to create, relative to workspace root. Default: workspace.zip.' },
    },
    handler: async ({ source_path = '', output_path = 'workspace.zip', _chatId = '' } = {}) => {
      try {
        const rawOut = String(output_path || 'workspace.zip')
        // toLowerCase только для проверки расширения — не меняем имя файла
        const out = rawOut.toLowerCase().endsWith('.zip') ? rawOut : `${rawOut}.zip`
        const sourceRel = String(source_path || '').replace(/^\/+/, '')
        const sourceAbs = safePath(sourceRel) // safePath('') → workspace root — intentional (zip whole workspace)
        const outputAbs = safePath(out.replace(/^\/+/, ''))
        // Проверяем секреты ДО создания архива — блокируем если найдены HIGH-risk
        const scan = await scanSecrets({ root: source_path || '' })
        if (!scan.ok || scan.high > 0) {
          return err(`Secret scan blocked zip: ${scan.high} high-risk finding(s) found in source files. Remove secrets before archiving.`)
        }
        await fsMkdir(path.dirname(outputAbs), { recursive: true })
        const zip = new AdmZip()
        const sourceName = String(source_path || '').trim().replace(/^\/+|\/+$/g, '')
        const rootRel = sourceName ? path.basename(sourceName) : ''
        await addPathToZip(zip, sourceAbs, rootRel, outputAbs)
        const buffer = zip.toBuffer()
        await fsWriteFile(outputAbs, buffer)
        await makeAgentWritable(outputAbs)
        return ok({ file_path: out, path: out, source_path: source_path || '.', bytes: buffer.length, entries: zip.getEntries().length, secret_scan: { ok: scan.ok, high: scan.high, medium: scan.medium, excludedSensitiveFiles: true }, download_url: `/api/workspace/download?path=${encodeURIComponent(out)}${_chatId ? `&chatId=${encodeURIComponent(_chatId)}` : ''}`, visible_in_files: true })
      } catch (e) { return err(e.message) }
    },
  },

};
