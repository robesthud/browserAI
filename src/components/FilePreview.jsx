import { useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { IconClose, IconDownload } from '../icons.jsx'
import { formatWorkspaceSize } from '../lib/workspace.js'
import Markdown from '../lib/markdown.jsx'

const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'json', 'py', 'sql', 'sh', 'yml',
  'yaml', 'md', 'xml', 'toml', 'ini', 'env', 'txt',
])

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function highlightCode(text, ext) {
  let html = escapeHtml(text)

  html = html.replace(
    /(&quot;.*?&quot;|'.*?'|`.*?`)/g,
    '<span class="code-string">$1</span>',
  )
  html = html.replace(
    /\b(function|return|const|let|var|if|else|for|while|switch|case|break|import|from|export|default|class|new|try|catch|finally|async|await|true|false|null|undefined)\b/g,
    '<span class="code-keyword">$1</span>',
  )
  html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="code-number">$1</span>')
  html = html.replace(/(\/\/.*$)/gm, '<span class="code-comment">$1</span>')
  html = html.replace(/(#.*$)/gm, '<span class="code-comment">$1</span>')

  if (ext === 'html' || ext === 'xml') {
    html = html.replace(/(&lt;\/?)([a-zA-Z0-9-]+)/g, '$1<span class="code-tag">$2</span>')
  }

  if (ext === 'css') {
    html = html.replace(/([.#]?[a-zA-Z0-9_-]+)(\s*\{)/g, '<span class="code-tag">$1</span>$2')
  }

  return html
}

export default function FilePreview({
  file,
  onClose,
  onDownload,
  onSave,
  onAiEdit,
  onRestoreHistory,
  startEditing = false,
}) {
  const [wrap, setWrap] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const [editing, setEditing] = useState(Boolean(startEditing && file?.kind === 'text'))
  const [draft, setDraft] = useState(file?.text || '')
  const [busy, setBusy] = useState(false)

  const ext = file?.name?.split('.').pop()?.toLowerCase() || ''
  const isImage = file?.kind === 'image' && file?.dataUrl
  const isPdf = file?.kind === 'pdf' && file?.dataUrl
  const isText = file?.kind === 'text' && file?.text != null
  const isMarkdown = isText && (ext === 'md' || ext === 'markdown')
  const isCode = isText && CODE_EXT.has(ext) && !isMarkdown

  // #8 FIX: пропускаем результат highlightCode через DOMPurify перед вставкой в DOM
  const highlighted = useMemo(() => {
    if (!isCode) return ''
    const raw = highlightCode(file?.text, ext)
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ['span'],
      ALLOWED_ATTR: ['class'],
    })
  }, [ext, file?.text, isCode])

  if (!file) return null

  const save = async () => {
    if (!onSave) return
    setBusy(true)
    try {
      await onSave(file, draft)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const aiEdit = async () => {
    if (!onAiEdit) return
    setBusy(true)
    try {
      await onAiEdit(file)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />

      <div className="flex h-full w-1/2 min-w-[320px] flex-col border-l border-white/10 bg-graphite-850 shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-[14px] text-cream">{file.name}</div>
            <div className="text-[11px] text-cream-faint">
              {file.mime || file.type || 'файл'} · {formatWorkspaceSize(file.size)}
              {file.truncated ? ' · показан фрагмент' : ''}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isText && !editing && (
              <>
                <button
                  onClick={() => setEditing(true)}
                  title="Редактировать"
                  className="rounded-lg px-2 py-1 text-[11px] text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
                >
                  Edit
                </button>
                <button
                  onClick={() => setShowHistory((v) => !v)}
                  title="История изменений"
                  className="rounded-lg px-2 py-1 text-[11px] text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
                >
                  History
                </button>
                <button
                  onClick={aiEdit}
                  disabled={busy}
                  title="Применить AI patch"
                  className="rounded-lg px-2 py-1 text-[11px] text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
                >
                  AI Patch
                </button>
              </>
            )}
            {isText && editing && (
              <>
                <button
                  onClick={() => {
                    setDraft(file.text || '')
                    setEditing(false)
                  }}
                  title="Отмена"
                  className="rounded-lg px-2 py-1 text-[11px] text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={busy}
                  title="Сохранить"
                  className="rounded-lg bg-cream px-2.5 py-1 text-[11px] font-medium text-graphite-900 transition-colors disabled:opacity-50"
                >
                  Save
                </button>
              </>
            )}
            {isText && !editing && (
              <button
                onClick={() => setWrap((v) => !v)}
                title={wrap ? 'Отключить перенос строк' : 'Включить перенос строк'}
                className="rounded-lg px-2 py-1 text-[11px] text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
              >
                {wrap ? 'No wrap' : 'Wrap'}
              </button>
            )}
            <button
              onClick={() => onDownload?.(file)}
              title="Скачать"
              className="grid h-8 w-8 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
            >
              <IconDownload />
            </button>
            <button
              onClick={onClose}
              title="Закрыть"
              className="grid h-8 w-8 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
            >
              <IconClose />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <div className="flex h-full gap-4">
            <div className="thin-scroll min-h-0 flex-1 overflow-auto">
              {isImage ? (
                <img
                  src={file.dataUrl}
                  alt={file.name}
                  className="mx-auto max-h-full max-w-full rounded-lg object-contain"
                />
              ) : isPdf ? (
                <div className="flex h-full flex-col items-center justify-center gap-4">
                  {/* Встроенный просмотр PDF — работает в Chrome, но не во всех WebView */}
                  <iframe
                    title={file.name}
                    src={file.dataUrl}
                    className="h-full w-full rounded-lg border border-white/10 bg-white"
                    onError={(e) => { e.target.style.display='none' }}
                  />
                  {/* Fallback кнопка для Android WebView где PDF не рендерится */}
                  <a
                    href={file.dataUrl}
                    download={file.name}
                    className="rounded-xl border border-white/20 bg-graphite-750 px-4 py-2 text-[13px] text-cream-soft hover:bg-graphite-700 hover:text-cream transition-colors"
                  >
                    ⬇ Скачать PDF
                  </a>
                </div>
              ) : isMarkdown && !editing ? (
                <div className="rounded-xl border border-white/5 bg-graphite-900/40 p-4">
                  <Markdown text={file.text} />
                </div>
              ) : editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-full min-h-[60vh] w-full resize-none rounded-xl border border-white/10 bg-graphite-900/60 p-4 font-mono text-[12.5px] leading-relaxed text-cream-soft focus:border-cream/30 focus:outline-none"
                />
              ) : isCode ? (
                <pre
                  className={`code-block ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'} overflow-auto rounded-xl border border-white/5 bg-graphite-900/40 p-4 font-mono text-[12.5px] leading-relaxed text-cream-soft`}
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              ) : isText ? (
                <pre className={`${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'} rounded-xl border border-white/5 bg-graphite-900/40 p-4 font-mono text-[12.5px] leading-relaxed text-cream-soft`}>
                  {file.text}
                </pre>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-cream-faint">
                  <p className="text-[13px]">Предпросмотр для этого типа файла недоступен.</p>
                  <button
                    onClick={() => onDownload?.(file)}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
                  >
                    Скачать файл
                  </button>
                </div>
              )}
            </div>

            {showHistory && isText && (
              <aside className="thin-scroll w-[240px] shrink-0 overflow-y-auto rounded-xl border border-white/5 bg-graphite-900/40 p-3">
                <div className="mb-2 text-[12px] font-medium text-cream">История</div>
                {file.history?.length ? (
                  <div className="space-y-2">
                    {file.history.map((item) => (
                      <div key={item.id} className="rounded-lg border border-white/5 px-3 py-2">
                        <div className="text-[12px] text-cream-soft">{new Date(item.createdAt).toLocaleString('ru-RU')}</div>
                        <div className="text-[11px] text-cream-faint">{item.reason || 'edit'} · {formatWorkspaceSize(item.size)}</div>
                        <button
                          onClick={() => onRestoreHistory?.(file, item.id)}
                          className="mt-2 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-cream-faint">История пока пуста.</div>
                )}
              </aside>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
