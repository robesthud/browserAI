// Минимальный безопасный рендер Markdown без внешних зависимостей.
// Кодовые блоки — сворачиваемые окошки CodeBlock (можно свернуть/развернуть/редактировать).
// Работает правильно и во время стриминга (незакрытый ``` тоже рендерится как CodeBlock).

import DOMPurify from 'dompurify'
import { useMemo } from 'react'
import CodeBlock from '../components/CodeBlock.jsx'

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderInline(text) {
  let t = escapeHtml(text)
  t = t.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return t
}

function linkify(html) {
  let out = html.replace(
    /!\[([^\]]*)\]\((data:image\/[^\s)]+|https?:\/\/[^\s)]+)\)/g,
    (_m, alt, url) => `<img src="${url}" alt="${alt || 'image'}" loading="lazy" class="md-img preserve-color" />`,
  )
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`,
  )
  return out
}

function splitTableRow(line = '') {
  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line = '') {
  const cells = splitTableRow(line)
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function looksLikeTableRow(line = '') {
  return /\|/.test(line) && splitTableRow(line).length > 1
}

// Разбивает Markdown на сегменты: { type:'html', content } | { type:'code', lang, code, streaming }
// streaming=true — блок ещё не закрыт (идёт стрим) — рендерится как CodeBlock сразу,
// чтобы код не высыпался в чат как обычный текст
function parseSegments(md) {
  const lines = md.split('\n')
  const segments = []

  let i = 0
  let inCode = false
  let codeLang = ''
  let codeBuf = []
  let htmlBuf = []
  let listBuf = []
  let listType = null

  const flushList = () => {
    if (!listBuf.length) return
    htmlBuf.push(
      `<${listType} class="md-list">${listBuf
        .map((li) => {
          const task = String(li).match(/^\[([ xX])\]\s+(.*)$/)
          if (task) {
            const checked = task[1].toLowerCase() === 'x'
            return `<li class="md-task"><span class="md-task-box">${checked ? '✓' : ''}</span>${linkify(renderInline(task[2]))}</li>`
          }
          return `<li>${linkify(renderInline(li))}</li>`
        })
        .join('')}</${listType}>`,
    )
    listBuf = []
    listType = null
  }

  const flushHtml = () => {
    if (!htmlBuf.length) return
    segments.push({ type: 'html', content: htmlBuf.join('') })
    htmlBuf = []
  }

  while (i < lines.length) {
    const line = lines[i]

    // ── fence: начало или конец блока кода ──────────────────────────────
    // Принимаем и ``` и ~~~, с любым языком после открывашки
    const fenceOpen  = !inCode && line.match(/^(`{3,}|~{3,})(\S*)\s*$/)
    const fenceClose =  inCode && line.match(/^(`{3,}|~{3,})\s*$/)

    if (fenceOpen) {
      flushList(); flushHtml()
      inCode = true
      codeLang = fenceOpen[2] || ''
      codeBuf = []
      i++; continue
    }

    if (fenceClose) {
      segments.push({ type: 'code', lang: codeLang, code: codeBuf.join('\n'), streaming: false })
      inCode = false; codeLang = ''; codeBuf = []
      i++; continue
    }

    if (inCode) {
      codeBuf.push(line)
      i++; continue
    }

    // ── tables: header row + separator + body rows ──────────────────────
    if (looksLikeTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushList()
      const header = splitTableRow(line)
      i += 2
      const rows = []
      while (i < lines.length && looksLikeTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      htmlBuf.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${header
          .map((cell) => `<th>${linkify(renderInline(cell))}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${header.map((_, idx) => `<td>${linkify(renderInline(row[idx] || ''))}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      )
      continue
    }

    // ── blockquote ───────────────────────────────────────────────────────
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushList()
      const parts = []
      while (i < lines.length) {
        const q = lines[i].match(/^>\s?(.*)$/)
        if (!q) break
        parts.push(q[1])
        i++
      }
      htmlBuf.push(`<blockquote class="md-quote">${parts.map((part) => `<p class="md-p">${linkify(renderInline(part))}</p>`).join('')}</blockquote>`)
      continue
    }

    // ── горизонтальная линия ─────────────────────────────────────────────
    if (line.match(/^---+\s*$/)) {
      flushList()
      htmlBuf.push('<hr class="md-hr" />')
      i++; continue
    }

    // ── заголовки ────────────────────────────────────────────────────────
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flushList()
      const lvl = h[1].length
      htmlBuf.push(`<h${lvl} class="md-h md-h${lvl}">${linkify(renderInline(h[2]))}</h${lvl}>`)
      i++; continue
    }

    // ── списки ───────────────────────────────────────────────────────────
    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ul) {
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'; listBuf.push(ul[1])
      i++; continue
    }
    if (ol) {
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'; listBuf.push(ol[1])
      i++; continue
    }

    // ── пустая строка ────────────────────────────────────────────────────
    if (line.trim() === '') {
      flushList(); i++; continue
    }

    // ── обычный абзац ────────────────────────────────────────────────────
    flushList()
    htmlBuf.push(`<p class="md-p">${linkify(renderInline(line))}</p>`)
    i++
  }

  // Незакрытый блок (стрим ещё идёт) — рендерим как CodeBlock с пометкой streaming
  // чтобы код НЕ высыпался в чат как обычный текст
  if (inCode) {
    flushList(); flushHtml()
    segments.push({ type: 'code', lang: codeLang, code: codeBuf.join('\n'), streaming: true })
    return segments
  }

  flushList(); flushHtml()
  return segments
}

function SafeHtml({ html }) {
  const clean = useMemo(() => {
    const sanitized = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['h1','h2','h3','h4','strong','em','code','a','li','ul','ol','p','div','span','br','img','hr','blockquote','table','thead','tbody','tr','th','td'],
      ALLOWED_ATTR: ['href','target','rel','class','src','alt','loading'],
    })
    return { __html: sanitized }
  }, [html])

  return <div className="md" dangerouslySetInnerHTML={clean} />
}

export default function Markdown({ text }) {
  const segments = useMemo(() => parseSegments(text || ''), [text])

  return (
    <div>
      {segments.map((seg, idx) => {
        if (seg.type === 'code') {
          return (
            <CodeBlock
              key={idx}
              lang={seg.lang}
              code={seg.code}
              streaming={seg.streaming}
            />
          )
        }
        return <SafeHtml key={idx} html={seg.content} />
      })}
    </div>
  )
}
