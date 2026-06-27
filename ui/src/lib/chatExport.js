/**
 * Convert a chat object into a self-contained Markdown document.
 * Includes attachments (as name + size), tool calls (collapsed code blocks),
 * thoughts and final assistant text. Used by Topbar → "Скачать .md".
 */
export function chatToMarkdown(chat) {
  if (!chat) return ''
  const lines = []
  lines.push(`# ${chat.title || 'BrowserAI chat'}`)
  lines.push('')
  lines.push(`_Exported ${new Date().toISOString()}._`)
  lines.push('')

  for (const m of chat.messages || []) {
    const who = m.role === 'user' ? '👤 You' : '🤖 Assistant'
    const ts = m.createdAt ? ` _(${new Date(m.createdAt).toLocaleString()})_` : ''
    lines.push(`---`)
    lines.push(`### ${who}${ts}`)
    if (Array.isArray(m.attachments) && m.attachments.length) {
      lines.push('')
      lines.push('**Attachments**')
      for (const a of m.attachments) {
        lines.push(`- ${a.name || 'file'} (${a.type || 'application/octet-stream'}${a.size ? `, ${a.size} B` : ''})`)
      }
    }
    if (m.content) {
      lines.push('')
      lines.push(m.content)
    }
    if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
      lines.push('')
      lines.push('<details><summary>Tool calls</summary>')
      lines.push('')
      for (const tc of m.toolCalls) {
        const ok = tc.status === 'done' ? (tc.ok ? '✓' : '✗') : '…'
        lines.push(`**${ok} ${tc.name}**`)
        if (tc.args && Object.keys(tc.args).length) {
          lines.push('```json')
          lines.push(JSON.stringify(tc.args, null, 2).slice(0, 1200))
          lines.push('```')
        }
        if (tc.status === 'done') {
          if (tc.ok && tc.result != null) {
            const body = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)
            lines.push('```')
            lines.push(String(body).slice(0, 2000))
            lines.push('```')
          } else if (!tc.ok) {
            lines.push(`> Error: ${tc.error || 'unknown'}`)
          }
        }
        lines.push('')
      }
      lines.push('</details>')
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function downloadChatMarkdown(chat) {
  const md = chatToMarkdown(chat)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const name = (chat?.title || 'chat').replace(/[^\w\s.-]+/g, '').slice(0, 60) || 'chat'
  a.href = url
  a.download = `${name}.md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
