import { useEffect, useRef, useState } from 'react'
import { IconBot, IconUser, IconFile, IconCopy } from '../icons.jsx'
import { formatSize } from '../lib/files.js'
import Markdown from '../lib/markdown.jsx'

function Attachments({ items }) {
  if (!items?.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-graphite-900/60 px-2.5 py-1.5 text-[12px] text-cream-soft"
        >
          {a.dataUrl && a.type.startsWith('image/') ? (
            <img
              src={a.dataUrl}
              alt={a.name}
              className="h-8 w-8 rounded object-cover"
            />
          ) : (
            <span className="text-cream-dim">
              <IconFile />
            </span>
          )}
          <span className="max-w-[160px] truncate">{a.name}</span>
          <span className="text-cream-faint">{formatSize(a.size)}</span>
        </div>
      ))}
    </div>
  )
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          // Clipboard API: работает на HTTPS и в современных WebView
          // Fallback через execCommand для старых Android WebView
          try {
            await navigator.clipboard.writeText(text)
          } catch {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
            document.body.appendChild(ta)
            ta.focus()
            ta.select()
            document.execCommand('copy')
            ta.remove()
          }
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {
          /* ignore */
        }
      }}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-cream-faint
                 opacity-0 transition-opacity hover:text-cream group-hover:opacity-100"
      title="Скопировать"
    >
      <IconCopy />
      {done ? 'Скопировано' : 'Копировать'}
    </button>
  )
}

function WorkingSpinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cream/25 border-t-cream"
      aria-label="AI работает"
      title="AI работает"
    />
  )
}

function Message({ m, isLast, aiWorking }) {
  const isUser = m.role === 'user'
  return (
    <div className="group flex gap-3 px-4 py-5">
      <div
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full
          ${isUser ? 'bg-graphite-600 text-cream' : 'bg-cream text-graphite-900'}`}
      >
        {isUser ? <IconUser /> : <IconBot />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[13px] font-medium text-cream flex items-center gap-2">
            {isUser ? 'Вы' : 'Ассистент'}
            {!isUser && isLast && aiWorking && <WorkingSpinner />}
          </span>
          {m.content && !m.pending && <CopyButton text={m.content} />}
        </div>

        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-cream-soft">
            {m.content}
          </p>
        ) : m.error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
            ⚠ {m.error}
          </div>
        ) : (
          <div className="text-[14px] leading-relaxed text-cream-soft">
            {m.content ? <Markdown text={m.content} /> : null}
            {m.pending && (
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-cream/70 align-middle" />
            )}
            {m.stopped && !m.content && (
              <span className="italic text-cream-faint">— генерация остановлена</span>
            )}
          </div>
        )}

        <Attachments items={m.attachments} />
      </div>
    </div>
  )
}

export default function MessageList({ messages, aiWorking }) {
  const bottomRef = useRef(null)
  const prevLenRef = useRef(messages.length)

  // Скроллим вниз только когда появляется новое сообщение,
  // но НЕ при переключении чата из сайдбара (там длина может не меняться)
  useEffect(() => {
    const prevLen = prevLenRef.current
    prevLenRef.current = messages.length
    if (messages.length > prevLen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  return (
    <div className="thin-scroll flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl divide-y divide-white/[0.04]">
        {messages.map((m, i) => (
          <Message key={m.id} m={m} isLast={i === messages.length - 1} aiWorking={aiWorking} />
        ))}
      </div>
      <div ref={bottomRef} className="h-4" />
    </div>
  )
}
