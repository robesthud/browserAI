import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { getOperatorMission } from './operatorMode.js'
import { getOperatorCodeTask, renderCodeTaskReport } from './operatorCode.js'
import { getWorkflow, renderWorkflowReport } from './agentWorkflows.js'
import { getJob } from './jobs.js'
import { getDeploySession, renderDeploySessionReport } from './deploySessions.js'
import { getIncident } from './incidents.js'
import { runOpsAction } from './ops.js'

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || (fsSync.existsSync('/workspace') ? '/workspace' : path.join(process.cwd(), 'workspace'))
const REPORT_DIR = path.join(WORKSPACE_ROOT, '.browserai', 'reports')

function fmt(ts) { try { return ts ? new Date(ts).toISOString() : '' } catch { return '' } }
function clip(s = '', max = 12000) { const x = String(s || ''); return x.length > max ? x.slice(0, max) + `\n…[truncated ${x.length - max} chars]` : x }
function mdCode(text = '', lang = '') { return `\`\`\`${lang}\n${String(text || '').replace(/```/g, '``\\`')}\n\`\`\`` }

function section(title, body) {
  const text = Array.isArray(body) ? body.filter(Boolean).join('\n') : String(body || '')
  return text.trim() ? `\n## ${title}\n\n${text.trim()}\n` : ''
}

function renderEvents(events = []) {
  if (!events.length) return ''
  return events.map((e) => `- ${fmt(e.createdAt)} **${e.type || 'info'} / ${e.title || e.phase || 'event'}**${e.message ? ` — ${e.message}` : ''}`).join('\n')
}

export function renderIncidentReport(incident) {
  if (!incident) return ''
  const rca = incident.details?.rca
  return [
    `# Incident Report: ${incident.title}`,
    '',
    `- ID: \`${incident.id}\``,
    `- Status: **${incident.status}**`,
    `- Severity: **${incident.severity}**`,
    `- Source: \`${incident.source}\``,
    `- Created: ${fmt(incident.createdAt)}`,
    incident.workflowId ? `- Workflow: \`${incident.workflowId}\`` : '',
    section('RCA', rca ? [
      `Primary category: **${rca.primaryCategory}**`,
      '',
      rca.summary,
      '',
      '### Evidence',
      ...(rca.evidence || []).map((e) => `- ${e.title || e.idx}: ${e.error || e.category || ''}`),
      '',
      '### Recommended actions',
      ...(rca.recommendedActions || []).map((a) => `- ${a}`),
    ] : 'No RCA attached yet.'),
    section('Details', mdCode(JSON.stringify(incident.details || {}, null, 2), 'json')),
  ].filter(Boolean).join('\n')
}

export function renderDeployReport(session) {
  if (!session) return ''
  return [
    renderDeploySessionReport(session),
    section('Events', renderEvents(session.events || [])),
    session.result?.logs?.stdout ? section('Recent logs', mdCode(clip(session.result.logs.stdout, 8000), 'log')) : '',
  ].filter(Boolean).join('\n')
}

export function renderCodeTaskFullReport(codeTask) {
  if (!codeTask) return ''
  const verify = codeTask.verify || {}
  const finalize = codeTask.result?.finalize
  const ci = codeTask.result?.ci
  const ciFix = codeTask.result?.ciFix
  const review = codeTask.result?.review
  return [
    `# Code Operator Report: ${codeTask.goal || codeTask.id}`,
    '',
    `- Task: \`${codeTask.id}\``,
    `- Status: **${codeTask.status}**`,
    `- Repo: \`${codeTask.repo}\``,
    `- Branch: \`${codeTask.branch}\``,
    `- Workdir: \`${codeTask.workdir}\``,
    `- Created: ${fmt(codeTask.createdAt)}`,
    codeTask.finishedAt ? `- Finished: ${fmt(codeTask.finishedAt)}` : '',
    codeTask.error ? `- Error: ${codeTask.error}` : '',
    section('Verification', renderCodeTaskReport(codeTask, verify)),
    section('Review / Risk Gate', review ? [
      `Risk: **${review.risk}**`,
      `Approved for merge: **${review.approvedForMerge ? 'yes' : 'no'}**`,
      `Approved for deploy: **${review.approvedForDeploy ? 'yes' : 'no'}**`,
      review.blockers?.length ? `Blockers:\n${review.blockers.map((b) => `- ${b}`).join('\n')}` : '',
      review.warnings?.length ? `Warnings:\n${review.warnings.map((w) => `- ${w}`).join('\n')}` : '',
      review.git?.stat ? `\nDiff stat:\n${mdCode(review.git.stat, 'diff')}` : '',
    ] : 'No review generated yet.'),
    section('Finalize / PR', finalize ? [
      `Committed: **${finalize.committed ? 'yes' : 'no'}**`,
      finalize.commit ? `Commit: \`${finalize.commit}\`` : '',
      finalize.branch ? `Branch: \`${finalize.branch}\`` : '',
      finalize.pullRequest?.url ? `PR: ${finalize.pullRequest.url}` : '',
    ] : 'Not finalized yet.'),
    section('CI', ci ? [
      `Status: **${ci.status}**`,
      `OK: **${ci.ok ? 'yes' : 'no'}**`,
      ...(ci.runs || []).map((r) => `- ${r.name || r.id}: ${r.status}/${r.conclusion || ''} ${r.url || ''}`),
      ci.failedLogs ? `\nFailed logs:\n${mdCode(clip(ci.failedLogs, 8000), 'log')}` : '',
    ] : 'CI not checked yet.'),
    section('CI Auto-fix', ciFix ? mdCode(JSON.stringify(ciFix, null, 2), 'json') : ''),
  ].filter(Boolean).join('\n')
}

export function renderMissionReport(mission) {
  if (!mission) return ''
  const codeTask = mission.codeTask || (mission.result?.codeTaskId ? getOperatorCodeTask(mission.result.codeTaskId) : null)
  const workflow = mission.workflow || (mission.workflowId ? getWorkflow(mission.workflowId) : null)
  const job = mission.job || (mission.jobId ? getJob(mission.jobId) : null)
  return [
    `# Operator Mission Report: ${mission.title}`,
    '',
    `- Mission: \`${mission.id}\``,
    `- Type: \`${mission.type}\``,
    `- Status: **${mission.status}**`,
    `- Goal: ${mission.goal || '(none)'}`,
    `- Created: ${fmt(mission.createdAt)}`,
    mission.finishedAt ? `- Finished: ${fmt(mission.finishedAt)}` : '',
    mission.error ? `- Error: ${mission.error}` : '',
    section('Timeline', renderEvents(mission.events || [])),
    codeTask ? section('Code task', renderCodeTaskFullReport(codeTask)) : '',
    workflow ? section('Workflow', renderWorkflowReport(workflow)) : '',
    job ? section('Background job', [
      `Job: \`${job.id}\``,
      `Status: **${job.status}**`,
      job.error ? `Error: ${job.error}` : '',
      job.result?.content ? clip(job.result.content, 6000) : '',
    ]) : '',
  ].filter(Boolean).join('\n')
}

export function getOperatorReport({ kind = 'mission', id = '' } = {}) {
  if (!id) throw new Error('id required')
  if (kind === 'mission') return { kind, id, markdown: renderMissionReport(getOperatorMission(id)) }
  if (kind === 'code-task') return { kind, id, markdown: renderCodeTaskFullReport(getOperatorCodeTask(id)) }
  if (kind === 'deploy') return { kind, id, markdown: renderDeployReport(getDeploySession(id)) }
  if (kind === 'incident') return { kind, id, markdown: renderIncidentReport(getIncident(id)) }
  throw new Error(`unknown report kind: ${kind}`)
}

export async function saveOperatorReport({ kind = 'mission', id = '' } = {}) {
  const report = getOperatorReport({ kind, id })
  if (!report.markdown.trim()) throw new Error('report is empty')
  await fs.mkdir(REPORT_DIR, { recursive: true })
  const file = `${kind}-${id}-${Date.now()}.md`.replace(/[^a-zA-Z0-9_.-]/g, '-')
  const abs = path.join(REPORT_DIR, file)
  await fs.writeFile(abs, report.markdown, 'utf8')
  return { ...report, path: `.browserai/reports/${file}` }
}

export async function sendOperatorReportTelegram({ kind = 'mission', id = '' } = {}) {
  const report = getOperatorReport({ kind, id })
  if (!report.markdown.trim()) throw new Error('report is empty')
  const chunks = report.markdown.match(/[\s\S]{1,3500}/g) || [report.markdown]
  for (const chunk of chunks.slice(0, 4)) {
    await runOpsAction({ service: 'telegram', action: 'notify_admin', params: { text: chunk }, confirm: true })
  }
  return { ...report, sent: true, chunks: Math.min(chunks.length, 4) }
}

export default { getOperatorReport, saveOperatorReport, sendOperatorReportTelegram, renderMissionReport, renderCodeTaskFullReport, renderDeployReport, renderIncidentReport }
