/**
 * WipBanner — a visual "В разработке" (Work In Progress) indicator.
 * Renders as a prominent but non-blocking banner above the wrapped content,
 * making it clear that the feature is not yet functional.
 *
 * Props:
 *   level: 'stub' | 'semi' — full stub vs. semi-functional
 *   title: optional title text
 *   detail: optional explanation
 *   compact: if true, renders a small inline badge instead of a full banner
 */

export default function WipBanner({ level = 'stub', title, detail, compact = false }) {
  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${
          level === 'stub'
            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
            : 'bg-sky-500/15 text-sky-300 border border-sky-500/25'
        }`}
        title={detail || (level === 'stub' ? 'Эндпоинт-заглушка: бэкенд не реализован' : 'Ограниченная реализация: данные могут быть пустыми')}
      >
        <span className="text-[9px]">{level === 'stub' ? '🚧' : '⚗️'}</span>
        {level === 'stub' ? 'WIP' : 'Partial'}
      </span>
    )
  }

  return (
    <div
      className={`mb-3 rounded-lg border px-3 py-2.5 text-[12px] leading-snug ${
        level === 'stub'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          : 'border-sky-500/25 bg-sky-500/8 text-sky-200'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5">{level === 'stub' ? '🚧' : '⚗️'}</span>
        <div>
          <p className="font-semibold">
            {title || (level === 'stub' ? 'Раздел в разработке' : 'Ограниченная реализация')}
          </p>
          <p className="mt-0.5 opacity-80">
            {detail || (level === 'stub'
              ? 'Бэкенд-логика для этого раздела ещё не реализована. Кнопки и панели отображаются, но действий не выполняют.'
              : 'Бэкенд-эндпоинт существует, но возвращает пустые или демо-данные. Полная функциональность в разработке.')}
          </p>
        </div>
      </div>
    </div>
  )
}
