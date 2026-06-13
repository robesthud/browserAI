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

function cleanPath(value = '') {
  return String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^\/+/, '').replace(/\.\./g, '')
}


const ACTIONS = [
  {
    id: 'list_files',
    tool: 'list_files',
    risk: 'safe',
    requiresApproval: false,
    reason: 'list-files-command',
    priority: 80,
    match(text) {
      if (!has(text, /(покажи|показать|список|посмотри|открой).{0,30}(файл|файлы|папк|workspace)|^(ls|dir)\b/i)) return null
      return {
        args: { path: '' },
        successReason: 'list-files-shortcut',
        errorReason: 'list-files-error',
        successText: (r) => {
          const root = r?.result || {}
          const names = Array.isArray(root.children) ? root.children.slice(0, 30).map((x) => `${x.type === 'directory' ? '📁' : '📄'} ${x.name}`).join('\n') : ''
          return `✅ Файлы в workspace:\n\n${names || '(пусто)'}`
        },
        errorText: (r) => `❌ Не смог показать файлы: ${r?.error || 'unknown error'}`,
      }
    },
  },
  {
    id: 'read_file',
    tool: 'read_file',
    risk: 'safe',
    requiresApproval: false,
    reason: 'read-file-command',
    priority: 85,
    match(text) {
      if (!has(text, /(прочитай|покажи|открой|read|cat)/i)) return null
      const candidates = [
        'README.md', 'AGENTS.md', 'package.json', '.env.example',
      ]
      let path = candidates.find((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text))
      if (!path) {
        const m = String(text || '').match(/[`"']?([A-Za-z0-9._/-]+\.(?:md|json|js|jsx|ts|tsx|css|html|yml|yaml|txt|env))[`"']?/i)
        path = m?.[1] || ''
      }
      if (!path) return null
      return {
        args: { path },
        successReason: 'read-file-shortcut',
        errorReason: 'read-file-error',
        successText: (r) => {
          const content = String(r?.result?.content || '').slice(0, 6000)
          return `✅ Прочитал \`${path}\`:\n\n\`\`\`\n${content}\n\`\`\``
        },
        errorText: (r) => `❌ Не смог прочитать \`${path}\`: ${r?.error || 'unknown error'}`,
      }
    },
  },
  {
    id: 'repo_download',
    tool: 'git_clone',
    risk: 'safe_write',
    requiresApproval: false,
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
    id: 'create_folder',
    tool: 'create_folder',
    risk: 'write',
    requiresApproval: false,
    reason: 'create-folder-command',
    priority: 82,
    match(text) {
      const m = String(text || '').match(/(?:создай|создать|сделай)\s+(?:папку|директорию|folder)\s+[`"']?([^`"'\n]+?)[`"']?\s*$/i)
      const path = cleanPath(m?.[1] || '')
      if (!path) return null
      return {
        args: { path },
        successReason: 'create-folder-shortcut',
        errorReason: 'create-folder-error',
        successText: () => `✅ Папка создана: \`${path}\`.`,
        errorText: (r) => `❌ Не смог создать папку \`${path}\`: ${r?.error || 'unknown error'}`,
      }
    },
  },
  {
    id: 'rename_item',
    tool: 'rename_item',
    risk: 'write',
    requiresApproval: true,
    reason: 'rename-command',
    priority: 86,
    match(text) {
      const m = String(text || '').match(/(?:переименуй|переименовать|rename)\s+[`"']?([^`"'\n]+?)[`"']?\s+(?:в|to)\s+[`"']?([^`"'\n/]+)[`"']?\s*$/i)
      const path = cleanPath(m?.[1] || '')
      const new_name = cleanPath(m?.[2] || '')
      if (!path || !new_name || new_name.includes('/')) return null
      return {
        args: { path, new_name },
        approvalQuestion: `Переименовать \`${path}\` в \`${new_name}\`?`,
        successReason: 'rename-shortcut',
        errorReason: 'rename-error',
        successText: (r) => `✅ Переименовано: \`${path}\` → \`${r?.result?.path || new_name}\`.`,
        errorText: (r) => `❌ Не смог переименовать \`${path}\`: ${r?.error || 'unknown error'}`,
      }
    },
  },
  {
    id: 'delete_file',
    tool: 'delete_file',
    risk: 'destructive',
    requiresApproval: true,
    reason: 'delete-command',
    priority: 88,
    match(text) {
      const m = String(text || '').match(/(?:удали|удалить|delete|remove)\s+(?:файл|папку|директорию|folder|file)?\s*[`"']?([^`"'\n]+?)[`"']?\s*$/i)
      const path = cleanPath(m?.[1] || '')
      if (!path) return null
      return {
        args: { path },
        approvalQuestion: `Удалить \`${path}\`? Это действие может быть необратимым.`,
        successReason: 'delete-shortcut',
        errorReason: 'delete-error',
        successText: () => `✅ Удалено: \`${path}\`.`,
        errorText: (r) => `❌ Не смог удалить \`${path}\`: ${r?.error || 'unknown error'}`,
      }
    },
  },
  {
    id: 'archive_zip',
    tool: 'zip_files',
    risk: 'safe_write',
    requiresApproval: false,
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
      risk: action.risk || 'safe',
      requiresApproval: Boolean(action.requiresApproval),
      priority: action.priority,
      ...routed,
    })
  }
  matches.sort((a, b) => b.priority - a.priority)
  return matches[0] || null
}

export function listDeterministicActions() {
  return ACTIONS.map(({ id, tool, reason, risk = 'safe', requiresApproval = false, priority }) => ({ id, tool, reason, risk, requiresApproval, priority }))
}
