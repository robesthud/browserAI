/**
 * repoMap.js
 *
 * Генерирует сжатую карту репозитория для улучшения "заземления" (grounding) ИИ.
 * Извлекает структуру папок и ключевые символы (экспорты, классы, функции)
 * из файлов, чтобы агент понимал архитектуру, не читая все файлы целиком.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { safePath } from './workspace.js'

const MAX_MAP_SIZE = 1024 * 16 // 16KB лимит на карту
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.history', 'assets'])
const EXT_REGEX = /\.(js|jsx|ts|tsx|py|go|rs|cpp|h)$/i

/**
 * Простой парсер символов (regex-based для скорости и универсальности)
 */
function extractSymbols(content) {
  const symbols = []
  // Ищем экспорты, функции, классы
  const patterns = [
    /export\s+(?:function|class|const|async\s+function)\s+([a-zA-Z0-9_]+)/g,
    /function\s+([a-zA-Z0-9_]+)\s*\(/g,
    /class\s+([a-zA-Z0-9_]+)/g,
  ]
  
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] && !symbols.includes(match[1])) {
        symbols.push(match[1])
      }
    }
  }
  return symbols.slice(0, 10) // Берем первые 10 самых важных
}

export async function buildRepoMap(rootRel = '') {
  const root = safePath(rootRel)
  let map = ''
  
  async function walk(dir, depth = 0) {
    if (depth > 8) return // Scan deeper
    const entries = await fs.readdir(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        map += `${'  '.repeat(depth)}📁 ${entry.name}/\n`
        await walk(fullPath, depth + 1)
      } else if (EXT_REGEX.test(entry.name) || entry.name === 'package.json' || entry.name === 'Dockerfile') {
        const stat = await fs.stat(fullPath).catch(() => null)
        if (stat && stat.size < 50000) { // Only read files under 50KB for symbols
          const content = await fs.readFile(fullPath, 'utf8').catch(() => '')
          const symbols = extractSymbols(content)
          map += `${'  '.repeat(depth)}📄 ${entry.name}${symbols.length ? ' -> (' + symbols.join(', ') + ')' : ''}\n`
        } else {
          map += `${'  '.repeat(depth)}📄 ${entry.name}\n`
        }
      }
      
      if (map.length > MAX_MAP_SIZE) break
    }
  }

  try {
    await walk(root)
    return map || 'Workspace is empty.'
  } catch (e) {
    return `Error building map: ${e.message}`
  }
}
