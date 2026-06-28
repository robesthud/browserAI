const BASE = '/api/workspace'
let activeChatId = ''

export function setWorkspaceChatId(chatId = '') {
  activeChatId = String(chatId || '')
}

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(activeChatId ? { 'X-BrowserAI-Chat-Id': activeChatId } : {}),
      ...(options.headers || {}),
    },
    ...options,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Workspace API ${res.status}: ${text}`)
  }

  const type = res.headers.get('content-type') || ''
  if (type.includes('application/json')) return res.json()
  return res.text()
}

export const workspaceApi = {
  setChatId: setWorkspaceChatId,

  initChatWorkspace: (chatId) =>
    req('/chat/init', {
      method: 'POST',
      headers: chatId ? { 'X-BrowserAI-Chat-Id': String(chatId) } : {},
      body: JSON.stringify({ chatId }),
    }),

  deleteChatWorkspace: (chatId) =>
    req('/chat', {
      method: 'DELETE',
      headers: chatId ? { 'X-BrowserAI-Chat-Id': String(chatId) } : {},
      body: JSON.stringify({ chatId }),
    }),

  getTree: (showHidden = false, opts = {}) => {
    const params = [`hidden=${showHidden ? '1' : '0'}`]
    if (opts.ifRevision) params.push(`ifRevision=${encodeURIComponent(opts.ifRevision)}`)
    return req(`/tree?${params.join('&')}`)
  },

  readFile: (path) => req(`/file?path=${encodeURIComponent(path)}`),

  getEvents: (limit = 200, opts = {}) => {
    const params = [`limit=${encodeURIComponent(limit)}`]
    if (opts.runId) params.push(`runId=${encodeURIComponent(opts.runId)}`)
    if (opts.path) params.push(`path=${encodeURIComponent(opts.path)}`)
    return req(`/events?${params.join('&')}`)
  },

  getDiffs: (path = '', limit = 500, opts = {}) => {
    const params = [`limit=${encodeURIComponent(limit)}`]
    if (path) params.push(`path=${encodeURIComponent(path)}`)
    if (opts.runId) params.push(`runId=${encodeURIComponent(opts.runId)}`)
    return req(`/diff?${params.join('&')}`)
  },

  searchContent: (query, showHidden = false) =>
    req(`/search?q=${encodeURIComponent(query)}&hidden=${showHidden ? '1' : '0'}`),

  getHistory: (path) =>
    req(`/history?path=${encodeURIComponent(path)}`),

  restoreHistory: (path, revisionId) =>
    req('/history/restore', {
      method: 'POST',
      body: JSON.stringify({ path, revisionId }),
    }),

  createFolder: (parentPath, name) =>
    req('/folder', {
      method: 'POST',
      body: JSON.stringify({ parentPath, name }),
    }),

  createFile: (parentPath, name, content = '') =>
    req('/file', {
      method: 'POST',
      body: JSON.stringify({ parentPath, name, content }),
    }),

  saveFile: (path, content) =>
    req('/file', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),

  rename: (path, newName) =>
    req('/rename', {
      method: 'POST',
      body: JSON.stringify({ path, newName }),
    }),

  move: (sourcePath, targetDirPath) =>
    req('/move', {
      method: 'POST',
      body: JSON.stringify({ sourcePath, targetDirPath }),
    }),

  remove: (path) =>
    req('/item', {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    }),

  uploadFiles: (parentPath, files) =>
    req('/upload', {
      method: 'POST',
      body: JSON.stringify({ parentPath, files }),
    }),

  uploadFromUrl: (parentPath, url, options = {}) =>
    req('/upload-url', {
      method: 'POST',
      body: JSON.stringify({ parentPath, url, ...options }),
    }),

  // The download endpoint is consumed as <a href="…">, which cannot send
  // custom headers — so we MUST embed the chat scope and (optionally) the
  // inline flag right in the query string. Otherwise the server runs the
  // download outside the chat's workspace scope and returns a 400 JSON
  // error which the browser then saves as a tiny .json file (the bug
  // visible to the user as "generated-….pn….js" of 0.10 KB).
  downloadUrl: (path, opts = {}) => {
    const params = [`path=${encodeURIComponent(path)}`]
    if (activeChatId) params.push(`chatId=${encodeURIComponent(activeChatId)}`)
    if (opts.inline) params.push('inline=1')
    return `${BASE}/download?${params.join('&')}`
  },
}

export function formatWorkspaceSize(bytes) {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function filterWorkspaceTree(node, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return node
  if (!node) return null

  const selfMatch = node.name.toLowerCase().includes(q)
  if (node.type === 'file') return selfMatch ? node : null

  const children = (node.children || [])
    .map((child) => filterWorkspaceTree(child, q))
    .filter(Boolean)

  if (selfMatch || children.length > 0) {
    return { ...node, children }
  }

  return null
}

export async function serializeUploadFiles(fileList) {
  const files = await Promise.all(
    Array.from(fileList).map(
      (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = String(reader.result || '')
            const base64 = result.includes(',') ? result.split(',')[1] : result
            resolve({
              path: file.webkitRelativePath || file.name,
              name: file.name,
              content: base64,
              type: file.type || 'application/octet-stream',
              size: file.size,
            })
          }
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        }),
    ),
  )

  return files
}
