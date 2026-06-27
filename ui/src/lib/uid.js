// Единственный источник uid() для всего проекта.
// Используем crypto.randomUUID() — гарантирует уникальность без коллизий.
export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback для старых окружений (старые Android WebView)
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}
