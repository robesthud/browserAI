import { useEffect, useState } from 'react'

/**
 * ProviderStatusBadge — Sprint C
 * Компактный бейдж текущей модели + статус в header чата.
 * Подписывается на SSE agentContext для обновления при fallback.
 */

export default function ProviderStatusBadge({ activeKey, agentContext, isBusy }) {
  // BUG-2 fix: track previous agentContext to detect model switch (= fallback)
  const [prevModel, setPrevModel] = useState(null)
  const [isFallback, setIsFallback] = useState(false)

  // Model from live agentContext SSE or from settings
  const model = agentContext?.provider?.model || agentContext?.provider?.id || activeKey?.model || ''
  const shortModel = model
    ? model.replace(/^models\//, '').split('/').pop().split(':')[0].slice(0, 24)
    : ''

  useEffect(() => {
    if (!model) return
    if (prevModel && prevModel !== model) {
      // Model changed mid-session → this is a fallback switch
      setIsFallback(true)
    }
    setPrevModel(model)
  }, [model])  

  // Reset fallback indicator when a new chat/session starts (agentContext becomes null)
  useEffect(() => {
    if (!agentContext) { setIsFallback(false); setPrevModel(null) }
  }, [agentContext])

  if (!shortModel) return null

  // BUG-9 fix: removed unused isDeepSeek/isGemini/isOllama variables
  const dot = isFallback ? '🔀' : isBusy ? '🟢' : '⚪'
  const label = isFallback ? `${shortModel} (fallback)` : shortModel

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono transition-colors ${
        isFallback
          ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'
          : isBusy
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-white/10 bg-black/10 text-cream-faint'
      }`}
      title={`Модель: ${model}${isFallback ? ' (автофаллбек)' : ''}`}
    >
      <span>{dot}</span>
      <span className="truncate max-w-[120px]">{label}</span>
    </span>
  )
}
