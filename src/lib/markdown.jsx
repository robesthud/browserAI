// Минимальный безопасный рендер Markdown без внешних зависимостей.
// Поддержка: заголовки, **жирный**, *курсив*, `inline code`, ```блоки кода```,
// списки (- / 1.), ссылки, переносы строк. HTML экранируется.

import DOMPurify from 'dompurify'
import { useMemo } from 'react'

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderInline(text) {
  let t = escapeHtml(text)
  // inline code
  t = t.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
  // bold
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  // italic
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  // ссылки обрабатываются отдельно в linkify()
  return t
}

// Аккуратная сборка ссылок (regex выше упрощён) — делаем явно
function linkify(html) {
  return html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`,
  )
}

function toHtml(md) {
  const lines = md.split('\n')
  const out = []
  let i = 0
  let inCode = false
  let codeLang = ''
  let codeBuf = []
  let listBuf = []
  let listType = null // 'ul' | 'ol'

  const flushList = () => {
    if (listBuf.length) {
      out.push(
        `<${listType} class="md-list">${listBuf
          .map((li) => `<li>${linkify(renderInline(li))}</li>`)
          .join('')}</${listType}>`,
      )
      listBuf = []
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // блок кода
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      if (!inCode) {
        flushList()
        inCode = true
        codeLang = fence[1] || ''
        codeBuf = []
      } else {
        out.push(
          `<pre class="md-pre"><div class="md-pre-head">${escapeHtml(
            codeLang || 'code',
          )}</div><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`,
        )
        inCode = false
      }
      i++
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      i++
      continue
    }

    // заголовки
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flushList()
      const level = h[1].length
      out.push(
        `<h${level} class="md-h md-h${level}">${linkify(
          renderInline(h[2]),
        )}</h${level}>`,
      )
      i++
      continue
    }

    // списки
    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ul) {
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'
      listBuf.push(ul[1])
      i++
      continue
    }
    if (ol) {
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'
      listBuf.push(ol[1])
      i++
      continue
    }

    // пустая строка
    if (line.trim() === '') {
      flushList()
      i++
      continue
    }

    // обычный абзац
    flushList()
    out.push(`<p class="md-p">${linkify(renderInline(line))}</p>`)
    i++
  }

  // #22 FIX: незакрытый code-блок отображается с визуальным предупреждением
  if (inCode) {
    out.push(
      `<pre class="md-pre md-pre--unclosed"><div class="md-pre-head">${escapeHtml(codeLang || 'code')} ⚠ незакрытый блок</div><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`,
    )
  }
  flushList()
  return out.join('')
}

export default function Markdown({ text }) {
  const html = useMemo(() => {
    const raw = toHtml(text || '')
    const clean = DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ['h1','h2','h3','strong','em','code','pre','a','li','ul','ol','p','div','span','br'],
      ALLOWED_ATTR: ['href','target','rel','class']
    })
    return { __html: clean }
  }, [text])
  return <div className="md" dangerouslySetInnerHTML={html} />
}
