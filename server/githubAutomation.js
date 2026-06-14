import db from './db.js'
import { startOperatorMission, listOperatorMissions } from './operatorMode.js'

let initialized = false
function now() { return Date.now() }
function id(prefix = 'gha') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function clip(s = '', max = 8000) { const x = String(s || ''); return x.length > max ? x.slice(0, max) + `\n…[truncated ${x.length - max} chars]` : x }

export function initGithubAutomation() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_automation_events (
      id TEXT PRIMARY KEY,
      delivery TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL DEFAULT '',
      issue_number INTEGER,
      pr_number INTEGER,
      command TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'received',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_github_automation_repo ON github_automation_events(repo, updated_at);
    CREATE INDEX IF NOT EXISTS idx_github_automation_status ON github_automation_events(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_github_automation_delivery ON github_automation_events(delivery);
  `)
  initialized = true
}

function rowToEvent(r) {
  if (!r) return null
  return {
    id: r.id,
    delivery: r.delivery,
    event: r.event,
    action: r.action,
    repo: r.repo,
    sender: r.sender,
    issueNumber: r.issue_number,
    prNumber: r.pr_number,
    command: r.command,
    status: r.status,
    result: parse(r.result_json, {}),
    error: r.error || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listGithubAutomationEvents({ limit = 50, repo = '' } = {}) {
  initGithubAutomation()
  const max = Math.max(1, Math.min(200, Number(limit) || 50))
  const rows = repo
    ? db.prepare('SELECT * FROM github_automation_events WHERE repo=? ORDER BY updated_at DESC LIMIT ?').all(String(repo), max)
    : db.prepare('SELECT * FROM github_automation_events ORDER BY updated_at DESC LIMIT ?').all(max)
  return rows.map(rowToEvent)
}

function insertEvent({ delivery = '', event = '', action = '', repo = '', sender = '', issueNumber = null, prNumber = null, command = '', status = 'received', result = {}, error = '' } = {}) {
  initGithubAutomation()
  const eventId = id('gha')
  const ts = now()
  db.prepare(`INSERT INTO github_automation_events (id,delivery,event,action,repo,sender,issue_number,pr_number,command,status,result_json,error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, String(delivery || ''), String(event || ''), String(action || ''), String(repo || ''), String(sender || ''), issueNumber, prNumber, String(command || '').slice(0, 2000), status, JSON.stringify(result || {}), String(error || '').slice(0, 4000), ts, ts)
  return rowToEvent(db.prepare('SELECT * FROM github_automation_events WHERE id=?').get(eventId))
}

function patchEvent(eventId, patch = {}) {
  initGithubAutomation()
  const cur = rowToEvent(db.prepare('SELECT * FROM github_automation_events WHERE id=?').get(String(eventId || '')))
  if (!cur) return null
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE github_automation_events SET status=?, result_json=?, error=?, updated_at=? WHERE id=?`).run(
    next.status || cur.status,
    JSON.stringify(next.result || cur.result || {}),
    next.error || '',
    now(),
    cur.id,
  )
  return rowToEvent(db.prepare('SELECT * FROM github_automation_events WHERE id=?').get(cur.id))
}

export function parseGithubAutomationCommand(text = '') {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^\/(browserai|agent)\b/i.test(l) || /^@browserai\b/i.test(l)) || ''
  if (!line) return null
  const normalized = line.replace(/^@browserai\b/i, '/browserai').replace(/^\/agent\b/i, '/browserai')
  const rest = normalized.replace(/^\/browserai\b/i, '').trim()
  const [verbRaw = 'help', ...tail] = rest.split(/\s+/)
  const verb = String(verbRaw || 'help').toLowerCase()
  const arg = tail.join(' ').trim()
  if (['run', 'do', 'start'].includes(verb)) return { verb: 'run', goal: arg, raw: line }
  if (['review', 'ревью'].includes(verb)) return { verb: 'review', goal: arg, raw: line }
  if (['fix-ci', 'fixci', 'ci'].includes(verb)) return { verb: 'fix-ci', goal: arg, raw: line }
  if (['status', 'статус'].includes(verb)) return { verb: 'status', goal: arg, raw: line }
  if (['help', 'помощь'].includes(verb)) return { verb: 'help', goal: arg, raw: line }
  return { verb: 'run', goal: rest, raw: line }
}

export function renderGithubCommandHelp() {
  return [
    'BrowserAI Operator commands:',
    '',
    '- `/browserai run <task>` — start an Operator mission from this issue/PR.',
    '- `/browserai review` — start a review/check mission for this PR.',
    '- `/browserai fix-ci` — start a CI investigation/fix mission.',
    '- `/browserai status` — show recent Operator missions.',
    '- `/browserai help` — show this help.',
  ].join('\n')
}

export function planGithubAutomationAction({ command = null, event = '', payload = {} } = {}) {
  const repo = payload.repository?.full_name || ''
  const issue = payload.issue || null
  const pr = payload.pull_request || (issue?.pull_request ? { number: issue.number, html_url: issue.html_url } : null)
  const number = issue?.number || pr?.number || payload.comment?.issue_url?.split('/').pop() || null
  if (!command) return { kind: 'ignore', repo, reason: 'no BrowserAI command found' }
  if (command.verb === 'help') return { kind: 'comment', repo, number: Number(number) || null, body: renderGithubCommandHelp() }
  if (command.verb === 'status') return { kind: 'status', repo, number: Number(number) || null }
  const url = payload.comment?.html_url || issue?.html_url || pr?.html_url || ''
  const title = issue?.title || pr?.title || ''
  let goal = command.goal
  if (!goal && command.verb === 'review') goal = `Review GitHub PR #${number} in ${repo}: ${title}`
  if (!goal && command.verb === 'fix-ci') goal = `Investigate and fix CI for GitHub PR/issue #${number} in ${repo}: ${title}`
  if (!goal) goal = `Handle GitHub ${event} #${number || ''} in ${repo}: ${title}`
  const prefix = [`GitHub command: ${command.raw}`, repo ? `Repo: ${repo}` : '', number ? `Thread: #${number}` : '', url ? `URL: ${url}` : ''].filter(Boolean).join('\n')
  return {
    kind: 'mission',
    repo,
    number: Number(number) || null,
    missionType: command.verb === 'fix-ci' ? 'fix_tests' : command.verb === 'review' ? 'code_task' : 'universal_dev_task',
    goal: `${prefix}\n\nTask:\n${goal}`,
  }
}

async function githubJson(path, { method = 'GET', body = null } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (!token) throw new Error('GITHUB_TOKEN is not configured')
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await r.text().catch(() => '')
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${clip(text, 1000)}`)
  return data
}

export async function commentGithubIssue({ repo = '', issueNumber = null, body = '' } = {}) {
  const slug = String(repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const num = Number(issueNumber)
  if (!slug || !num) throw new Error('repo and issueNumber are required')
  const data = await githubJson(`/repos/${slug}/issues/${num}/comments`, { method: 'POST', body: { body: String(body || '').slice(0, 60000) } })
  return { id: data.id, url: data.html_url, body: data.body }
}

function statusBody() {
  const missions = listOperatorMissions({ userId: '', limit: 5 })
  const lines = ['BrowserAI Operator status:', '']
  if (!missions.length) lines.push('No recent webhook-owned missions.')
  for (const m of missions) lines.push(`- ${m.status}: ${m.title} (${m.id})${m.error ? ` — ${m.error}` : ''}`)
  return lines.join('\n')
}

export async function handleGithubAutomationWebhook({ event = '', delivery = '', payload = {} } = {}) {
  initGithubAutomation()
  const action = payload.action || ''
  const repo = payload.repository?.full_name || ''
  const sender = payload.sender?.login || ''
  const issueNumber = payload.issue?.number || null
  const prNumber = payload.pull_request?.number || (payload.issue?.pull_request ? payload.issue?.number : null)
  const text = payload.comment?.body || payload.issue?.body || payload.pull_request?.body || ''
  const command = parseGithubAutomationCommand(text)
  const rec = insertEvent({ delivery, event, action, repo, sender, issueNumber, prNumber, command: command?.raw || '', status: command ? 'processing' : 'ignored', result: { command } })
  if (!command) return patchEvent(rec.id, { status: 'ignored', result: { reason: 'no command' } })

  try {
    const plan = planGithubAutomationAction({ command, event, payload })
    if (plan.kind === 'comment') {
      let comment = null
      try { comment = await commentGithubIssue({ repo: plan.repo, issueNumber: plan.number, body: plan.body }) } catch (e) { comment = { skipped: true, error: e.message } }
      return patchEvent(rec.id, { status: 'succeeded', result: { plan, comment } })
    }
    if (plan.kind === 'status') {
      let comment = null
      try { comment = await commentGithubIssue({ repo: plan.repo, issueNumber: plan.number, body: statusBody() }) } catch (e) { comment = { skipped: true, error: e.message, body: statusBody() } }
      return patchEvent(rec.id, { status: 'succeeded', result: { plan, comment } })
    }
    if (plan.kind === 'mission') {
      const mission = startOperatorMission({ userId: process.env.OPERATOR_GITHUB_USER_ID || '', projectId: 'browserai', type: plan.missionType, goal: plan.goal, confirm: false })
      let comment = null
      try { comment = await commentGithubIssue({ repo: plan.repo, issueNumber: plan.number, body: `BrowserAI Operator mission started: ${mission.id}\n\nStatus: ${mission.status}\nType: ${mission.type}` }) } catch (e) { comment = { skipped: true, error: e.message } }
      return patchEvent(rec.id, { status: 'succeeded', result: { plan, missionId: mission.id, missionStatus: mission.status, comment } })
    }
    return patchEvent(rec.id, { status: 'ignored', result: { plan } })
  } catch (e) {
    return patchEvent(rec.id, { status: 'failed', error: e?.message || String(e), result: { command } })
  }
}

export default { initGithubAutomation, listGithubAutomationEvents, parseGithubAutomationCommand, planGithubAutomationAction, renderGithubCommandHelp, handleGithubAutomationWebhook, commentGithubIssue }
