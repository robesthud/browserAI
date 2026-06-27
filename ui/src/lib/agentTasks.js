async function req(path, options = {}) {
  const res = await fetch(`/api/agent/tasks${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`))
  return res.json()
}

export function listAgentTasks(chatId = '', limit = 10) {
  return req(`?chatId=${encodeURIComponent(chatId || '')}&limit=${encodeURIComponent(limit)}`)
}

export function latestAgentTask(chatId = '') {
  return req(`/latest?chatId=${encodeURIComponent(chatId || '')}`)
}

export function getAgentTask(id) {
  return req(`/${encodeURIComponent(id)}`)
}

export function getResumeNote(id) {
  return req(`/${encodeURIComponent(id)}/resume-note`, { method: 'POST' })
}

export async function listActiveAgentRuns() {
  const res = await fetch('/api/agent/runs', { credentials: 'include' })
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`))
  return res.json()
}

export async function resetAgentRun(chatId) {
  const res = await fetch(`/api/agent/runs/${encodeURIComponent(chatId || '')}/reset`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`))
  return res.json()
}
