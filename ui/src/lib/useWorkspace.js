import { useCallback, useEffect, useRef, useState } from 'react'
import { workspaceApi } from './workspace.js'

function defaultShouldRefreshOnTool(data = {}) {
  const name = data.name || data.tool || ''
  return [
    'bash', 'shell_session_run', 'write_file', 'edit_file',
    'delete_file', 'download_url', 'git_clone', 'zip_files',
  ].includes(name)
}

export function useWorkspace({ chatId, isOpen, aiWorking, workspaceRevision, activeTab, refreshTerminal } = {}) {
  const [tree, setTree] = useState(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [filesError, setFilesError] = useState('')
  const [revision, setRevision] = useState('')
  const [fileRevisions, setFileRevisions] = useState({})
  const selectedFileRef = useRef(null)
  const treeRevisionRef = useRef('')
  const refreshTimerRef = useRef(null)

  const setSelectedFileRef = useCallback((file) => {
    selectedFileRef.current = file
  }, [])

  const refreshFilesNow = useCallback(async (silent = false, smart = false) => {
    if (!isOpen || !chatId) return null
    if (!silent) setLoadingFiles(true)
    setFilesError('')
    try {
      workspaceApi.setChatId(chatId)
      const data = await workspaceApi.getTree(false, smart ? { ifRevision: treeRevisionRef.current } : {})
      if (data.unchanged) {
        treeRevisionRef.current = data.revision || treeRevisionRef.current
        setRevision(treeRevisionRef.current)
        if (data.fileRevisions) setFileRevisions(data.fileRevisions)
        return data
      }
      treeRevisionRef.current = data.revision || ''
      setRevision(treeRevisionRef.current)
      setFileRevisions(data.fileRevisions || {})
      setTree(data.tree || null)
      return data
    } catch (e) {
      setFilesError(e.message || 'workspace load failed')
      return null
    } finally {
      if (!silent) setLoadingFiles(false)
    }
  }, [chatId, isOpen])

  const refreshFiles = useCallback((silent = false, opts = {}) => {
    const delay = Number(opts.delay ?? 1000)
    const smart = opts.smart !== false
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void refreshFilesNow(silent, smart)
    }, delay)
  }, [refreshFilesNow])

  const refreshAfterTool = useCallback((data = {}, opts = {}) => {
    if (!defaultShouldRefreshOnTool(data)) return false
    refreshFiles(true, { delay: opts.delay ?? 1000, smart: true })
    return true
  }, [refreshFiles])

  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
  }, [])

  useEffect(() => {
    if (!isOpen || !chatId) return
    workspaceApi.setChatId(chatId)
    workspaceApi.initChatWorkspace(chatId).catch(() => {})
    treeRevisionRef.current = ''
    setRevision('')
    setFileRevisions({})
    void refreshFilesNow(false, false)
  }, [isOpen, chatId, refreshFilesNow])

  useEffect(() => {
    if (!isOpen || !chatId || !workspaceRevision) return
    const data = typeof workspaceRevision === 'object' ? workspaceRevision : {}
    if (!refreshAfterTool(data, { delay: 1000 })) {
      refreshFiles(true, { delay: 1000, smart: true })
    }
    if (activeTab === 'terminal' && refreshTerminal) void refreshTerminal(true)
  }, [workspaceRevision, isOpen, chatId, activeTab, refreshFiles, refreshAfterTool, refreshTerminal])

  useEffect(() => {
    if (!isOpen || !chatId || !aiWorking) return
    const id = setInterval(() => refreshFiles(true, { delay: 250, smart: true }), 3000)
    return () => clearInterval(id)
  }, [isOpen, chatId, aiWorking, refreshFiles])

  return {
    tree,
    setTree,
    loadingFiles,
    setLoadingFiles,
    filesError,
    setFilesError,
    revision,
    fileRevisions,
    refreshFilesNow,
    refreshFiles,
    refreshAfterTool,
    setSelectedFileRef,
  }
}
