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
function extractSymbols(content, ext = '') {
  const symbols = []
  const imports = []
  let match
  
  if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) {
    // Извлекаем импорты (ES6 + CommonJS)
    const importRe = /(?:import\s+(?:[^'"]+\s+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g
    while ((match = importRe.exec(content)) !== null) {
      const name = match[1].split('/').pop()
      if (name && !imports.includes(name) && !name.startsWith('.')) {
        imports.push(name)
      }
    }
    
    // Извлекаем функции, классы и экспортные константы
    const patterns = [
      /export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g,
      /export\s+class\s+([a-zA-Z0-9_]+)/g,
      /export\s+const\s+([a-zA-Z0-9_]+)/g,
      /function\s+([a-zA-Z0-9_]+)\s*\(/g,
      /class\s+([a-zA-Z0-9_]+)/g,
    ]
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      while ((match = pattern.exec(content)) !== null) {
        if (match[1] && !symbols.includes(match[1]) && !['if', 'for', 'while', 'switch'].includes(match[1])) {
          symbols.push(match[1])
        }
      }
    }
  } else if (ext === 'py') {
    // Извлекаем Python импорты
    const importRe = /(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_, ]+))/g
    while ((match = importRe.exec(content)) !== null) {
      const imp = (match[1] || match[2] || '').trim().split(',')[0].trim()
      if (imp && !imports.includes(imp)) {
        imports.push(imp)
      }
    }
    
    // Извлекаем функции и классы в Python
    const patterns = [
      /def\s+([a-zA-Z0-9_]+)\s*\(/g,
      /class\s+([a-zA-Z0-9_]+)\s*(?:\(|:)/g,
    ]
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      while ((match = pattern.exec(content)) !== null) {
        if (match[1] && !symbols.includes(match[1])) {
          symbols.push(match[1])
        }
      }
    }
  }

  const infoParts = []
  if (imports.length) infoParts.push(`imports: ${imports.slice(0, 4).join(', ')}`)
  if (symbols.length) infoParts.push(`symbols: ${symbols.slice(0, 8).join(', ')}`)
  return infoParts.join(' | ')
}

export async function buildRepoMap(rootRel = '') {
  const root = safePath(rootRel)
  let map = ''
  
  async function walk(dir, depth = 0) {
    if (depth > 8) return
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
        const ext = entry.name.toLowerCase().split('.').pop()
        
        if (stat && stat.size < 50000) {
          const content = await fs.readFile(fullPath, 'utf8').catch(() => '')
          const info = extractSymbols(content, ext)
          map += `${'  '.repeat(depth)}📄 ${entry.name}${info ? ' -> (' + info + ')' : ''}\n`
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
