// Чтение загруженных пользователем файлов.
// Текстовые файлы читаем как текст (и отправляем модели),
// остальные сохраняем как метаданные + dataURL для предпросмотра/скачивания.

import { uid } from './storage.js'

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss',
  'html', 'htm', 'xml', 'yml', 'yaml', 'csv', 'py', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'rb', 'php', 'sh', 'sql', 'env', 'ini', 'toml', 'log', 'vue',
  'svelte', 'config',
])

const MAX_TEXT_BYTES = 200 * 1024 // 200 КБ текста на файл, чтобы не раздувать контекст

function isTextFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (TEXT_EXT.has(ext)) return true
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json') return true
  return false
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export async function processFile(file) {
  const base = {
    id: uid(),
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    text: null,
    dataUrl: null,
    truncated: false,
  }

  try {
    if (isTextFile(file)) {
      let text = await readAsText(file)
      if (text.length > MAX_TEXT_BYTES) {
        text = text.slice(0, MAX_TEXT_BYTES)
        base.truncated = true
      }
      base.text = text
    } else {
      // бинарь — сохраняем dataURL (для картинок можно показывать превью)
      base.dataUrl = await readAsDataURL(file)
    }
  } catch {
    base.error = 'Не удалось прочитать файл'
  }

  return base
}

export async function processFiles(fileList) {
  const arr = Array.from(fileList)
  return Promise.all(arr.map(processFile))
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
