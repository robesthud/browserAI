// Экспорт/импорт ключей в JSON-файл.

import { normalizeKey } from './settings.js'

export function exportKeysToFile(settings) {
  const payload = {
    type: 'browserai-keys',
    version: 2,
    exportedAt: new Date().toISOString(),
    activeKeyId: settings.activeKeyId,
    keys: settings.keys.map((k) => ({
      id: k.id,
      name: k.name,
      baseUrl: k.baseUrl,
      apiKey: k.apiKey,
      model: k.model,
      availableModels: k.availableModels || [],
      createdAt: k.createdAt,
    })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `browserai-keys-${stamp}.json`
  document.body.appendChild(a)
  // На Android WebView a.click() с download не работает — используем window.location
  if (/Android/i.test(navigator.userAgent) && !/Chrome/i.test(navigator.userAgent)) {
    window.location.href = url
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  } else {
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export function importKeysFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result)
        const keys = Array.isArray(data?.keys) ? data.keys : []
        if (!keys.length) {
          reject(new Error('В файле нет ключей'))
          return
        }
        const clean = keys.map((k) =>
          normalizeKey({
            id: k.id || Math.random().toString(36).slice(2, 10),
            name: k.name || '',
            baseUrl: k.baseUrl || 'https://api.openai.com/v1',
            apiKey: k.apiKey || '',
            model: k.model || '',
            availableModels: k.availableModels || (k.model ? [k.model] : []),
            createdAt: k.createdAt || Date.now(),
          }),
        )
        resolve({
          keys: clean,
          activeKeyId: data.activeKeyId || clean[0].id,
        })
      } catch {
        reject(new Error('Не удалось прочитать JSON'))
      }
    }
    reader.onerror = () => reject(new Error('Ошибка чтения файла'))
    reader.readAsText(file)
  })
}
