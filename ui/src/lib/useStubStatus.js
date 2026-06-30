/**
 * useStubStatus — discovers which backend endpoints are still stubs
 * so the UI can show honest "В разработке" indicators instead of
 * silently empty panels.
 *
 * Returns: { loading, stubs, semiStubs, isStub(path), isSemiStub(path), isWip(path) }
 */

import { useEffect, useState, useCallback, useRef } from 'react'

// Hardcoded fallback: if /api/stub-status is unreachable (e.g. offline),
// we still want to mark the most obviously-stub endpoints.
const FALLBACK_STUBS = [
  '/api/agent/policy',
  '/api/agent/provider/diagnose',
  '/api/agent/tasks',
  '/api/agent/jobs',
  '/api/cron',
  '/api/operator/projects/analyze',
  '/api/operator/runbooks',
  '/api/operator/runtime-adapters',
  '/api/operator/deploy-sessions',
  '/api/operator/recoveries',
  '/api/operator/recoveries/graph',
  '/api/operator/recoveries/supervise',
  '/api/operator/failure/classify',
  '/api/operator/failure/execute',
  '/api/operator/failure/incident',
  '/api/operator/github-automation/comment',
  '/api/operator/github-automation/events',
  '/api/operator/mcp/catalog',
  '/api/operator/mcp/install',
  '/api/operator/project-policy-presets',
  '/api/operator/project-templates',
]

const FALLBACK_SEMI = [
  '/api/agent/workflows',
  '/api/agent/recipes',
  '/api/operator/missions',
  '/api/operator/projects',
  '/api/operator/status',
  '/api/incidents',
]

let _cachedStubs = null
let _cachedSemi = null

export function useStubStatus() {
  const [stubs, setStubs] = useState(_cachedStubs || [])
  const [semiStubs, setSemiStubs] = useState(_cachedSemi || [])
  const [loading, setLoading] = useState(!_cachedStubs)
  const fetched = useRef(false)

  useEffect(() => {
    if (fetched.current) return
    fetched.current = true
    if (_cachedStubs) {
      setStubs(_cachedStubs)
      setSemiStubs(_cachedSemi)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    fetch('/api/stub-status', { credentials: 'include', signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        clearTimeout(timer)
        if (data && data.ok) {
          _cachedStubs = data.stubs || []
          _cachedSemi = data.semiStubs || []
          setStubs(_cachedStubs)
          setSemiStubs(_cachedSemi)
        } else {
          _cachedStubs = FALLBACK_STUBS
          _cachedSemi = FALLBACK_SEMI
          setStubs(_cachedStubs)
          setSemiStubs(_cachedSemi)
        }
      })
      .catch(() => {
        clearTimeout(timer)
        _cachedStubs = FALLBACK_STUBS
        _cachedSemi = FALLBACK_SEMI
        setStubs(_cachedStubs)
        setSemiStubs(_cachedSemi)
      })
      .finally(() => setLoading(false))
  }, [])

  const isStub = useCallback((path) => {
    if (!path) return false
    return stubs.includes(path)
  }, [stubs])

  const isSemiStub = useCallback((path) => {
    if (!path) return false
    return semiStubs.includes(path)
  }, [semiStubs])

  const isWip = useCallback((path) => {
    if (!path) return false
    return stubs.includes(path) || semiStubs.includes(path)
  }, [stubs, semiStubs])

  return { loading, stubs, semiStubs, isStub, isSemiStub, isWip }
}

/**
 * Check if ALL of the given paths are stubs or semi-stubs.
 * Useful for deciding whether an entire component is WIP.
 */
export function allWip(paths, isWip) {
  if (!paths || !paths.length) return false
  return paths.every(p => isWip(p))
}
