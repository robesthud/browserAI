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

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  rtf: 'application/rtf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif',
  zip: 'application/zip',
}

function inferMime(file) {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

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
    type: inferMime(file),
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
