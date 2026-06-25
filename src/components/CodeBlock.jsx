/**
 * CodeBlock — сворачиваемое окошко с кодом.
 * Рендерится вместо ```блоков кода``` в чате.
 * streaming=true — блок ещё не закрыт (идёт стрим), показываем курсор.
 */

import { useState, useRef, useEffect, useCallback } from 'react'

function langLabel(lang = '') {
  const l = String(lang || '').toLowerCase().trim()
  const MAP = {
    js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX',
    py: 'Python', python: 'Python', sh: 'Shell', bash: 'Bash',
    json: 'JSON', html: 'HTML', css: 'CSS', yaml: 'YAML', yml: 'YAML',
    toml: 'TOML', sql: 'SQL', md: 'Markdown', markdown: 'Markdown',
    rs: 'Rust', go: 'Go', java: 'Java', cpp: 'C++', c: 'C',
    rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin',
    xml: 'XML', dockerfile: 'Dockerfile', diff: 'Diff',
    vue: 'Vue', svelte: 'Svelte', scss: 'SCSS', sass: 'Sass',
  }
  return MAP[l] || (l ? l.charAt(0).toUpperCase() + l.slice(1) : 'Код')
}

function langIcon(lang = '') {
  const l = String(lang || '').toLowerCase().trim()
  if (['js', 'jsx', 'ts', 'tsx'].includes(l)) return '⬡'
  if (['py', 'python'].includes(l)) return '🐍'
  if (['sh', 'bash', 'zsh'].includes(l)) return '>_'
  if (l === 'json') return '{}'
  if (['html', 'xml', 'vue', 'svelte'].includes(l)) return '<>'
  if (['css', 'scss', 'sass'].includes(l)) return '🎨'
  if (['yaml', 'yml'].includes(l)) return '⚙'
  if (l === 'sql') return '🗄'
  if (['md', 'markdown'].includes(l)) return '📝'
  if (l === 'dockerfile') return '🐳'
  if (l === 'diff') return '±'
  return '📄'
}

function useAutoResize(ref, value) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 600) + 'px'
  }, [value, ref])
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return true
    } catch { return false }
  }
}

export default function CodeBlock({ lang = '', code = '', streaming = false }) {
  const lineCount = String(code).split('\n').length
  // Свёрнуто если блок длинный И стрим завершён
  const [open, setOpen] = useState(streaming || lineCount <= 20)
  const [copied, setCopied] = useState(false)
  const [edited, setEdited] = useState(String(code))
  const [isEditing, setIsEditing] = useState(false)
  const textareaRef = useRef(null)
  const prevStreamingRef = useRef(streaming)

  // Синхронизируем edited пока идёт стрим (код приходит кусками)
  useEffect(() => {
    if (streaming) {
      setEdited(String(code))
    }
  }, [code, streaming])

  // Когда стрим завершился — разворачиваем если блок короткий
  useEffect(() => {
    if (prevStreamingRef.current && !streaming) {
      prevStreamingRef.current = false
      if (lineCount <= 20) setOpen(true)
    }
  }, [streaming, lineCount])

  useAutoResize(textareaRef, edited)

  const handleCopy = useCallback(async (e) => {
    e.stopPropagation()
    const ok = await copyText(edited)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [edited])

  const label = langLabel(lang)
  const icon = langIcon(lang)
  const changed = !streaming && edited !== String(code)

  return (
    <div style={{
      margin: '0.5rem 0',
      border: `1px solid ${streaming ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: '0.6rem',
      background: '#1e2025',
      overflow: 'hidden',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      transition: 'border-color 0.3s',
    }}>

      {/* ── Шапка ── */}
      <div
        onClick={() => !streaming && setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.3rem 0.75rem',
          background: 'rgba(255,255,255,0.03)',
          borderBottom: open ? '1px solid rgba(255,255,255,0.06)' : 'none',
          cursor: streaming ? 'default' : 'pointer',
          userSelect: 'none',
          minHeight: '2rem',
        }}
      >
        <span style={{ fontSize: '0.75rem', color: '#9cc0ff', flexShrink: 0 }}>{icon}</span>

        <span style={{
          flex: 1,
          fontSize: '0.72rem',
          color: '#a6abb5',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
          {streaming && (
            <span style={{ marginLeft: '0.4rem', color: '#fbbf24', fontSize: '0.65rem' }}>
              ● пишет…
            </span>
          )}
          {changed && !streaming && (
            <span style={{ marginLeft: '0.4rem', color: '#fbbf24', fontSize: '0.65rem' }}>● изменён</span>
          )}
        </span>

        <span style={{ fontSize: '0.65rem', color: '#6b7280', flexShrink: 0 }}>
          {lineCount} {lineCount === 1 ? 'строка' : lineCount < 5 ? 'строки' : 'строк'}
        </span>

        {!streaming && (
          <button
            type="button"
            onClick={handleCopy}
            style={{
              background: copied ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '0.3rem',
              color: copied ? '#6ee7b7' : '#a6abb5',
              fontSize: '0.65rem',
              padding: '0.1rem 0.5rem',
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'all 0.15s',
            }}
          >
            {copied ? '✓ Скопировано' : 'Копировать'}
          </button>
        )}

        {!streaming && (
          <svg width="10" height="10" viewBox="0 0 12 12" style={{
            flexShrink: 0, opacity: 0.4,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
          }}>
            <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      {/* ── Тело ── */}
      {open && (
        <div style={{ position: 'relative' }}>

          {/* Кнопка редактировать — только когда стрим завершён */}
          {!streaming && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setIsEditing(v => !v) }}
              style={{
                position: 'absolute',
                top: '0.4rem',
                right: '0.5rem',
                zIndex: 2,
                background: isEditing ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '0.3rem',
                color: isEditing ? '#a5b4fc' : '#6b7280',
                fontSize: '0.62rem',
                padding: '0.1rem 0.45rem',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {isEditing ? '✓ Готово' : '✏ Изменить'}
            </button>
          )}

          {isEditing && !streaming ? (
            <textarea
              ref={textareaRef}
              value={edited}
              onChange={e => setEdited(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              style={{
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.75rem',
                paddingRight: '5rem',
                background: '#12151a',
                color: '#e6e8ec',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: '0.8rem',
                lineHeight: '1.55',
                border: 'none',
                outline: 'none',
                resize: 'none',
                minHeight: '4rem',
                maxHeight: '600px',
                overflowY: 'auto',
                whiteSpace: 'pre',
                overflowX: 'auto',
              }}
            />
          ) : (
            <pre style={{
              margin: 0,
              padding: '0.75rem',
              paddingRight: streaming ? '0.75rem' : '5rem',
              background: 'transparent',
              color: '#e6e8ec',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: '0.8rem',
              lineHeight: '1.55',
              overflowX: 'auto',
              overflowY: 'auto',
              maxHeight: streaming ? '400px' : '500px',
              whiteSpace: 'pre',
              wordBreak: 'normal',
            }}>
              <code>{edited}</code>
              {/* Пульсирующий курсор пока идёт стрим */}
              {streaming && (
                <span style={{
                  display: 'inline-block',
                  width: '0.5em',
                  height: '1em',
                  background: '#fbbf24',
                  marginLeft: '2px',
                  verticalAlign: 'text-bottom',
                  animation: 'blink 1s step-end infinite',
                }} />
              )}
            </pre>
          )}
        </div>
      )}

      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  )
}
