import express from 'express'
import { requireOwner } from '../authz.js'
import { safeErrorMessage } from '../errorSanitizer.js'
import { recentKpis, loadRecentRunLogs, loadRecentReplays } from '../qualityKpis.js'
import { summarizeRunLog, listRunLogIds, loadRunLog } from '../runLogs.js'
import { listReplayIds, loadReplay } from '../replayArtifact.js'
import { listIncidents, getIncident, resolveIncident } from '../incidents.js'
import { startOperatorMission, listOperatorMissions, getOperatorMission, listOperatorMissionEvents, cancelOperatorMission, resumeOperatorMission } from '../operatorMode.js'
import { listDeploySessions, createDeploySession, getDeploySession, startDeploySession, cancelDeploySession, resumeDeploySession } from '../deploySessions.js'
import { listRunbooks, readRunbook, writeRunbook } from '../operatorRunbooks.js'
import { listOperatorProjects, upsertOperatorProject } from '../operatorMode.js'
import { listProviderParityTargets, runProviderParitySmoke, runProviderParityMatrix } from '../providerParitySmoke.js'
import { listProviderParityScenarios } from '../providerParityScenarios.js'
import { runAgentSelfTest } from '../agentSelfTest.js'
import { MCP_CATALOG, getCatalogServer } from '../mcpCatalog.js'
import { getMcpConfig, setMcpServer, deleteMcpServer, stopMcpHub, startMcpHub, getMcpServerStatus } from '../mcpClient.js'

const router = express.Router()

router.use(requireOwner)

router.get('/incidents', (req, res) => {
  res.json({ incidents: listIncidents({ userId: req.user?.id }) })
})

router.get('/incidents/:id', (req, res) => {
  res.json({ incident: getIncident(req.params.id) })
})

router.post('/incidents/:id/resolve', (req, res) => {
  res.json({ ok: true, incident: resolveIncident(req.params.id, req.body) })
})

router.get('/missions', (req, res) => {
  res.json({ missions: listOperatorMissions({ userId: req.user?.id }) })
})

router.get('/missions/:id', (req, res) => {
  res.json({ mission: getOperatorMission(req.params.id) })
})

router.get('/deploy-sessions', (req, res) => {
  res.json({ sessions: listDeploySessions({ userId: req.user?.id }) })
})

router.get('/projects', (req, res) => {
  res.json({ projects: listOperatorProjects({ userId: req.user?.id }) })
})

router.get('/runbooks', async (req, res) => {
  res.json(await listRunbooks())
})

router.get('/provider-smoke/targets', (req, res) => {
  res.json({ providers: listProviderParityTargets({ activeOnly: req.query.activeOnly === '1' }) })
})

router.get('/provider-smoke/scenarios', (_req, res) => {
  res.json({ scenarios: listProviderParityScenarios() })
})

router.post('/provider-smoke', async (req, res) => {
  try {
    res.json(await runProviderParitySmoke({
      keyIds: Array.isArray(req.body?.keyIds) ? req.body.keyIds.map(String) : [],
      activeOnly: req.body?.activeOnly === true,
      includeAgent: req.body?.includeAgent !== false,
    }))
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) })
  }
})

router.post('/provider-smoke/matrix', async (req, res) => {
  try {
    res.json(await runProviderParityMatrix({
      keyIds: Array.isArray(req.body?.keyIds) ? req.body.keyIds.map(String) : [],
      activeOnly: req.body?.activeOnly === true,
      scenarioIds: Array.isArray(req.body?.scenarioIds) ? req.body.scenarioIds.map(String) : [],
      maxProviders: Number(req.body?.maxProviders || 0),
    }))
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) })
  }
})


import { listProviderSupport as _listProviderSupport } from '../providerSupport.js'
import { computeReleaseSafety as _computeReleaseSafety, listRollbackTargets as _listRollbackTargets, releaseSafetySummary as _releaseSafetySummary } from '../releaseSafety.js'

router.get('/provider-support', (_req, res) => {
  try {
    res.json({
      schema: 'browserai.provider_support.v1',
      providers: _listProviderSupport(),
      tiers: ['certified', 'experimental', 'unsupported', 'legacy'],
    })
  } catch (e) {
    res.status(500).json({ error: 'provider_support_failed', message: safeErrorMessage(e) })
  }
})

router.get('/release-safety', (_req, res) => {
  try {
    const snap = _computeReleaseSafety()
    const targets = _listRollbackTargets({ limit: 5 })
    res.json({
      schema: 'browserai.release_safety_dashboard.v1',
      ..._releaseSafetySummary(snap),
      checks: snap.checks,
      rollbackTargets: targets,
    })
  } catch (e) {
    res.status(500).json({ error: 'release_safety_failed', message: safeErrorMessage(e) })
  }
})



router.post('/agent-self-test', async (_req, res) => {
  try {
    const r = await runAgentSelfTest()
    res.json({ schema: 'browserai.agent_self_test.v1', ranAt: new Date().toISOString(), ...r })
  } catch (e) {
    res.status(500).json({ error: 'agent_self_test_failed', message: safeErrorMessage(e) })
  }
})



router.get('/kpis', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100))
    const k = recentKpis({ limit })
    res.json({
      schema: 'browserai.kpis.v1',
      requested: { limit },
      ...k,
    })
  } catch (e) {
    res.status(500).json({ error: 'kpis_failed', message: safeErrorMessage(e) })
  }
})

router.get('/runs', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50))
    const ids = listRunLogIds({ limit })
    const summaries = ids.map((id) => loadRunLog(id)).filter(Boolean).map((s) => summarizeRunLog(s))
    res.json({ schema: 'browserai.run_index.v1', count: summaries.length, runs: summaries })
  } catch (e) {
    res.status(500).json({ error: 'runs_index_failed', message: safeErrorMessage(e) })
  }
})

router.get('/runs/:runId', (req, res) => {
  try {
    // D — sanitize runId: strip path separators to prevent path-traversal into the runs/ dir
    const id = String(req.params.runId || '').replace(/[/\\.]/g, '_').replaceAll('\0', '_').slice(0, 128)
    const data = loadRunLog(id)
    if (!data) { res.status(404).json({ error: 'not_found' }); return }
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: 'run_load_failed', message: safeErrorMessage(e) })
  }
})

router.get('/replays', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50))
    const ids = listReplayIds({ limit })
    res.json({ schema: 'browserai.replay_index.v1', count: ids.length, runIds: ids })
  } catch (e) {
    res.status(500).json({ error: 'replays_index_failed', message: safeErrorMessage(e) })
  }
})

router.get('/replays/:runId', (req, res) => {
  try {
    const id = String(req.params.runId || '').replace(/[/\\.]/g, '_').replaceAll('\0', '_').slice(0, 128)
    const data = loadReplay(id)
    if (!data) { res.status(404).json({ error: 'not_found' }); return }
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: 'replay_load_failed', message: safeErrorMessage(e) })
  }
})

// ── Sprint 5B — MCP Marketplace endpoints ─────────────────────────────────

router.get('/mcp/catalog', (_req, res) => {
  res.json({ schema: 'browserai.mcp_catalog.v1', servers: MCP_CATALOG })
})

router.post('/mcp/install', requireOwner, async (req, res) => {
  try {
    const { serverId, envVars = {} } = req.body || {}
    if (!serverId) return res.status(400).json({ error: 'serverId required' })
    const catalog = getCatalogServer(serverId)
    if (!catalog) return res.status(404).json({ error: 'server not found in catalog' })

    // Substitute {{PLACEHOLDER}} in args and env
    const subst = (str) => String(str || '').replace(/{{(\w+)}}/g, (_, k) => String(envVars[k] || ''))

    const cfg = {
      command: catalog.install.command,
      args: (catalog.install.args || []).map(subst),
      env: Object.fromEntries(
        Object.entries(catalog.install.env || {}).map(([k, v]) => [k, subst(v)])
      ),
      enabled: true,
      _catalogId: serverId,
    }

    // Validate required envVars are filled
    for (const [key, meta] of Object.entries(catalog.envVars || {})) {
      if (meta.required && !envVars[key]) {
        return res.status(400).json({ error: `Required env var missing: ${key} (${meta.label})` })
      }
    }

    await setMcpServer(catalog.id, cfg)
    // Restart hub to pick up new server
    stopMcpHub()
    // S5-D1: startMcpHub is async but we don't await full init (can take 10s+)
    // Start it in background, respond immediately with 'starting' status
    startMcpHub().catch(e => console.warn('[mcp/install] hub restart failed:', e.message))
    // Short grace period for fast servers to register
    await new Promise(r => setTimeout(r, 800))
    res.json({ ok: true, serverId, status: getMcpServerStatus(), note: 'Hub restarting — tools available in ~5s' })
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) })
  }
})

router.delete('/mcp/server/:id', requireOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!id) return res.status(400).json({ error: 'id required' })
    await deleteMcpServer(id)
    stopMcpHub()
    startMcpHub().catch(e => console.warn('[mcp/delete] hub restart failed:', e.message))
    await new Promise(r => setTimeout(r, 800))
    res.json({ ok: true, status: getMcpServerStatus() })
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) })
  }
})

// Package H: Policy editor API
router.put('/projects/:id/policy', requireOwner, async (req, res) => {
  try {
    const { normalizeProjectPolicy, upsertOperatorProject, listOperatorProjects } = await import('../operatorMode.js')
    const projectId = String(req.params.id || '')
    const projects = listOperatorProjects({ userId: req.user?.id || '' })
    const project = projects.find(p => p.id === projectId)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const policy = normalizeProjectPolicy(req.body?.policy || {})
    const updated = upsertOperatorProject({
      userId: req.user?.id || '',
      id: projectId,
      name: project.name,
      repo: project.repo,
      localPath: project.localPath,
      productionPath: project.productionPath,
      defaultBranch: project.defaultBranch,
      meta: { ...project.meta, policy },
    })
    res.json({ ok: true, project: updated })
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) })
  }
})

// Package H: Audit log endpoint
router.get('/audit', requireOwner, async (req, res) => {
  try {
    const { readOpsAudit } = await import('../ops.js')
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    res.json(readOpsAudit({ limit }))
  } catch (e) {
    res.status(500).json({ error: safeErrorMessage(e) })
  }
})

export default router
