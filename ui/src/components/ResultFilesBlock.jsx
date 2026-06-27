function collectResultFiles(toolCalls = []) {
  const rows = []
  const seen = new Set()
  const add = (path, kind = 'changed') => {
    const clean = String(path || '').trim()
    if (!clean || seen.has(`${kind}:${clean}`)) return
    seen.add(`${kind}:${clean}`)
    rows.push({ path: clean, kind })
  }

  for (const tc of toolCalls || []) {
    if (!tc || tc.status !== 'done' || tc.ok === false) continue
    const action = tc.args?.action || ''
    const name = tc.name
    const path = tc.args?.path || tc.args?.file || tc.result?.path || tc.result?.file_path || tc.result?.filePath

    if (name === 'write_file' || (name === 'file' && action === 'write')) add(path, 'created')
    else if (name === 'edit_file' || (name === 'file' && action === 'edit')) add(path, 'changed')
    else if (name === 'delete_file' || (name === 'file' && action === 'delete')) add(path, 'deleted')
    else if (name === 'zip_files' || (name === 'file' && action === 'zip')) add(tc.result?.file_path || tc.args?.output_path || path, 'archive')
    else if (name === 'generate_image') add(tc.result?.path || tc.args?.path, 'created')
    else if (name === 'download_url') add(tc.result?.savedPath || tc.result?.path || tc.result?.filename, 'created')
  }

  return rows.slice(0, 8)
}

function label(kind) {
  if (kind === 'created') return 'создан'
  if (kind === 'changed') return 'изменён'
  if (kind === 'deleted') return 'удалён'
  if (kind === 'archive') return 'архив'
  return 'файл'
}

function isPreviewable(path = '') {
  return /\.(html?|pdf|png|jpe?g|webp|gif|svg|txt|md|json|css|js|jsx|ts|tsx)$/i.test(String(path || ''))
}

function fileUrl(path = '', chatId = '', inline = false) {
  const q = new URLSearchParams({ path })
  if (chatId) q.set('chatId', chatId)
  if (inline) q.set('inline', '1')
  return `/api/workspace/download?${q.toString()}`
}

export default function ResultFilesBlock({ toolCalls = [], chatId = '' }) {
  const files = collectResultFiles(toolCalls)
  if (!files.length) return null

  return (
    <div className="mt-3 rounded-xl border border-emerald-400/15 bg-emerald-500/5 p-2.5 text-[12px]">
      <div className="mb-1.5 flex items-center gap-1.5 font-medium text-emerald-200">
        <span>✓</span>
        <span>Файлы результата</span>
      </div>
      <div className="space-y-1">
        {files.map((f) => (
          <div key={`${f.kind}:${f.path}`} className="flex min-w-0 items-center gap-2 rounded-lg bg-graphite-900/45 px-2 py-1.5">
            <span className="shrink-0 rounded bg-graphite-800 px-1.5 py-0.5 text-[10px] text-cream-faint">{label(f.kind)}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream-soft" title={f.path}>{f.path}</code>
            {f.kind !== 'deleted' && isPreviewable(f.path) && (
              <a
                href={fileUrl(f.path, chatId, true)}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[11px] text-emerald-200/80 hover:text-emerald-100"
                title="Открыть preview"
              >открыть</a>
            )}
            {f.kind !== 'deleted' && (
              <a
                href={fileUrl(f.path, chatId)}
                className="shrink-0 text-[11px] text-emerald-200/80 hover:text-emerald-100"
                title="Скачать файл"
              >скачать</a>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
