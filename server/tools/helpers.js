/**
 * helpers.js
 * Common imports and helper functions for BrowserAI modular tools.
 */

import {
  getWorkspaceTree,
  readWorkspaceFile,
  createFile,
  createFolder,
  writeFileContent,
  renameItem,
  deleteItem,
  searchWorkspaceContent,
  getContainerWorkspaceRoot,
  safePath,
  makeAgentWritable,
} from '../workspace.js'
import { searchWeb, fetchWebPage } from '../web.js'
import { runSandboxCommand } from '../agentSandbox.js'
import { upsertFact, forgetFact, listFacts } from '../userMemory.js'
import { addDocument, deleteDocument, listDocuments, searchKnowledge } from '../knowledgeBase.js'
import { fetchViaProxy, isGoogleGenerativeNativeUrl, callLLM } from '../llmClient.js'
import { getActiveKeyDecrypted } from '../db.js'
import { writeFile as fsWriteFile, readFile as fsReadFile, mkdir as fsMkdir, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import { browserOpen, browserScreenshot, browserClick, browserType, browserClose } from '../browserTools.js'
import { computerScreenshot, computerClick, computerType, computerOpenApp, computerStatus } from '../computerUse.js'
import { listOpsServices, runOpsAction } from '../ops.js'
import { buildProjectProfile } from '../projectProfiler.js'
import { buildVerificationPlan } from '../verifyOrchestrator.js'
import { scanSecrets } from '../secretScan.js'
import { createWorkspaceSnapshot, listWorkspaceSnapshots, restoreWorkspaceSnapshot } from '../workspaceSnapshots.js'
import { runInSession, resetSession, startBackgroundTask, readBackgroundLogs, stopBackgroundTask, listBackgroundTasks } from '../shellSession.js'
import { detectWorkspaceChangesAround } from '../workspaceChangeTracker.js'
import { createUnifiedDiff } from '../workspaceDiff.js'
import { PRIVILEGED_TOOLS } from '../../runtime/index.js'
import AdmZip from 'adm-zip'
import path from 'node:path'

export function safeJsonParse(text) { try { return JSON.parse(text) } catch { return null } }

export function shQuote(value) {
  const s = String(value)
  if (s.includes('\x00')) throw new Error('shQuote: NUL byte (\x00) is not allowed in shell arguments')
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function scopedContainerRoot() {
  return getContainerWorkspaceRoot().replace(/\/+$/, '') || '/workspace'
}

export function rewriteWorkspacePaths(command = '') {
  const root = scopedContainerRoot()
  if (root === '/workspace') return String(command)
  if (String(command).includes('/workspace/chats/')) {
    return String(command)
  }
  return String(command).replace(/\/workspace(?=\/|\s|&&|;|\)|$)/g, root)
}

export async function runWorkspaceCommand(command, { timeoutMs = 120_000, signal, onStdout, onStderr } = {}) {
  const root = scopedContainerRoot()
  const prepared = `mkdir -p ${shQuote(root)} && cd ${shQuote(root)} && ${rewriteWorkspacePaths(command)}`
  return runSandboxCommand({ command: prepared, cwd: '/', timeoutMs, signal, onStdout, onStderr })
}

export function defaultCloneDir(url = '') {
  const tail = String(url).replace(/\/+$/, '').split('/').pop() || 'repo'
  const name = tail.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo'
  if (name === '.' || name === '..' || name.startsWith('./') || name.startsWith('../') || name.startsWith('-')) return 'repo'
  return name
}

export const ZIP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.vite', '.turbo', '.history', '.snapshots'])
export const ZIP_EXCLUDED_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.pem(\..*)?|.*\.key|id_rsa(\.pub)?|id_ed25519(\.pub)?|\.netrc|\.npmrc|\.pypirc|credentials|auth\.json|secrets?\.(json|ya?ml|env|txt)|.*\.pfx|.*\.p12)$/i

export async function addPathToZip(zip, abs, zipRel, outputAbs) {
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
  if (st.size > 50 * 1024 * 1024) {
    return { skipped: true, path: abs, reason: 'file > 50MB' }
  }
  const data = await fsReadFile(abs)
  zip.addFile(zipRel.replace(/\\/g, '/'), data)
}

export function truncate(str, max = 8000) {
  const s = String(str ?? '')
  return s.length > max ? s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]` : s
}

export function isCodeLikePath(pathValue = '') {
  return /\.(js|mjs|cjs|jsx|ts|tsx|json|css|scss|html|htm|yml|yaml|md|py|sh|sql|go|rs|java|php|rb|vue|svelte|toml|ini|env)$/i.test(String(pathValue || '')) || /(^|\/)Dockerfile$/i.test(String(pathValue || ''))
}

export function ok(result) { return { ok: true, result } }
export function err(message) { return { ok: false, error: String(message || 'unknown error') } }

export async function ensureParentDirs(relPath) {
  const parts = String(relPath).split('/').filter(Boolean)
  parts.pop() // remove filename
  let acc = ''
  for (const seg of parts) {
    const here = acc ? acc + '/' + seg : seg
    try { await createFolder(acc, seg) } catch { /* exists */ }
    acc = here
  }
}

// Re-export common dependencies for individual tool files
export {
  getWorkspaceTree,
  readWorkspaceFile,
  createFile,
  createFolder,
  writeFileContent,
  renameItem,
  deleteItem,
  searchWorkspaceContent,
  getContainerWorkspaceRoot,
  safePath,
  makeAgentWritable,
  searchWeb,
  fetchWebPage,
  runSandboxCommand,
  upsertFact,
  forgetFact,
  listFacts,
  addDocument,
  deleteDocument,
  listDocuments,
  searchKnowledge,
  fetchViaProxy,
  isGoogleGenerativeNativeUrl,
  callLLM,
  getActiveKeyDecrypted,
  fsWriteFile,
  fsReadFile,
  fsMkdir,
  fsReaddir,
  fsStat,
  browserOpen,
  browserScreenshot,
  browserClick,
  browserType,
  browserClose,
  computerScreenshot,
  computerClick,
  computerType,
  computerOpenApp,
  computerStatus,
  listOpsServices,
  runOpsAction,
  buildProjectProfile,
  buildVerificationPlan,
  scanSecrets,
  createWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
  runInSession,
  resetSession,
  startBackgroundTask,
  readBackgroundLogs,
  stopBackgroundTask,
  listBackgroundTasks,
  detectWorkspaceChangesAround,
  createUnifiedDiff,
  PRIVILEGED_TOOLS,
  AdmZip,
  path
}
