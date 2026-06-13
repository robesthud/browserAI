function textFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => p?.text || p?.content || '').filter(Boolean).join('\n')
  return ''
}

export function lastUserText(history = []) {
  return textFromContent([...(history || [])].reverse().find((m) => m?.role === 'user')?.content || '')
}

export function extractGithubRepoUrl(text = '') {
  const m = String(text || '').match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:\/)?/i)
  if (!m) return ''
  return m[0].replace(/\/$/, '').replace(/\.git$/i, '') + '.git'
}

function has(text, re) { return re.test(String(text || '')) }

const ACTIONS = [
  {
    id: 'repo_download',
    tool: 'git_clone',
    reason: 'github-download-command',
    priority: 100,
    match(text) {
      const url = extractGithubRepoUrl(text)
      if (!url) return null
      if (!has(text, /(скачай|скачать|загрузи|загрузить|клонир|clone|download|pull|обнови)/i)) return null
      return {
        args: { url },
        successReason: 'repo-download-shortcut',
        errorReason: 'repo-download-error',
        successText: (r) => {
          const path = r?.result?.path || 'repo'
          return `✅ Файлы скачаны в \`${path}\`.\n\nЯ только клонировал репозиторий — без анализа, установки зависимостей, сборки и тестов.`
        },
        errorText: (r) => `❌ Не смог скачать репозиторий: ${r?.error || 'unknown error'}`,
      }
    },
  },
  {
    id: 'archive_zip',
    tool: 'zip_files',
    reason: 'zip-command',
    priority: 90,
    match(text) {
      if (!has(text, /(zip|archive|архив|заархив|запак|упак|сжать)/i)) return null
      return {
        args: { source_path: '', output_path: 'workspace.zip' },
        successReason: 'archive-shortcut',
        errorReason: 'archive-error',
        successText: (r) => {
          const info = r?.result || {}
          return `✅ Архив готов: \`${info.file_path || 'workspace.zip'}\` (${info.entries || 0} файлов, ${info.bytes || 0} байт).\n\nОн появился в панели «Файлы» справа — можно скачать оттуда.`
        },
        errorText: (r) => `❌ Не смог создать ZIP: ${r?.error || 'unknown error'}`,
      }
    },
  },
]

export function routeDeterministicAction(history = []) {
  const text = lastUserText(history)
  const matches = []
  for (const action of ACTIONS) {
    const routed = action.match(text)
    if (!routed) continue
    matches.push({
      schema: 'browserai.deterministic_action.v1',
      id: action.id,
      tool: action.tool,
      reason: action.reason,
      priority: action.priority,
      ...routed,
    })
  }
  matches.sort((a, b) => b.priority - a.priority)
  return matches[0] || null
}

export function listDeterministicActions() {
  return ACTIONS.map(({ id, tool, reason, priority }) => ({ id, tool, reason, priority }))
}
