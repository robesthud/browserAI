import { useMemo, useState } from 'react'
import {
  IconChevronRight,
  IconFolderSolid,
  IconDownload,
  IconEye,
  IconFile,
  IconTrash,
} from '../icons.jsx'
import { formatWorkspaceSize } from '../lib/workspace.js'

function FileIcon({ name }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (ext === 'html') return <Badge bg="#e34c26" fg="#fff" label="5" />
  if (ext === 'json') return <Badge bg="#cb3837" fg="#fff" label="n" />
  if (ext === 'css') return <Badge bg="#2965f1" fg="#fff" label="#" />
  if (ext === 'md') return <span className="inline-block w-4" />
  if (ext === 'js' || ext === 'jsx') return <Badge bg="#f7df1e" fg="#000" label="JS" />
  if (ext === 'ts' || ext === 'tsx') return <Badge bg="#3178c6" fg="#fff" label="TS" />
  if (ext === 'py') return <Badge bg="#3776ab" fg="#fff" label="Py" />
  return <IconFile className="text-cream-faint" />
}

function Badge({ bg, fg, label }) {
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded text-[9px] font-bold leading-none"
      style={{ background: bg, color: fg }}
    >
      {label}
    </span>
  )
}

function Row({
  node,
  depth,
  activePath,
  onPreview,
  onDownload,
  onContextMenu,
  onMove,
  onDelete,
}) {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.type === 'dir'
  const pad = 10 + depth * 16
  const title = `${node.path || node.name}\n${formatWorkspaceSize(node.size)}`

  const dragPayload = useMemo(
    () => JSON.stringify({ path: node.path, type: node.type }),
    [node.path, node.type],
  )

  const onDragStart = (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/browserai-workspace', dragPayload)
  }

  const onDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    const raw = e.dataTransfer.getData('application/browserai-workspace')
    if (!raw) return
    const payload = JSON.parse(raw)
    const targetDirPath = isDir ? node.path : node.path.split('/').slice(0, -1).join('/')
    if (payload.path === node.path) return
    await onMove?.(payload.path, targetDirPath)
  }

  if (isDir) {
    return (
      <li>
        <div
          draggable={Boolean(node.path)}
          onDragStart={onDragStart}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={onDrop}
          onContextMenu={(e) => onContextMenu?.(e, node)}
          title={title}
          className="rounded-md"
        >
          <div
            className="group flex items-center rounded-md text-[13px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
            style={{ paddingLeft: pad }}
          >
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left"
            >
              <IconChevronRight
                className={`shrink-0 text-cream-faint transition-transform ${open ? 'rotate-90' : ''}`}
              />
              <span className="shrink-0 text-cream-dim">
                <IconFolderSolid />
              </span>
              <span className="truncate">{node.name}</span>
            </button>
            {node.path && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete?.(node)
                }}
                title="Удалить папку целиком"
                className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-cream-faint opacity-0 transition-all hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
              >
                <IconTrash />
              </button>
            )}
          </div>
        </div>

        {open && node.children?.length > 0 && (
          <ul>
            {node.children.map((child) => (
              <Row
                key={child.path || child.name}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onPreview={onPreview}
                onDownload={onDownload}
                onContextMenu={onContextMenu}
                onMove={onMove}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const isActive = activePath === node.path

  return (
    <li>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={onDrop}
        onContextMenu={(e) => onContextMenu?.(e, node)}
        title={title}
        className={`group flex items-center gap-2 rounded-md py-1 pr-1.5 text-[13px] transition-colors
          ${isActive ? 'bg-graphite-750 text-cream' : 'text-cream-dim hover:bg-graphite-750 hover:text-cream'}`}
        style={{ paddingLeft: pad + 18 }}
      >
        <button
          onClick={() => onPreview?.(node)}
          title="Просмотр"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <FileIcon name={node.name} />
          <span className="truncate">{node.name}</span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => onPreview?.(node)}
            title="Просмотр"
            className="grid h-6 w-6 place-items-center rounded text-cream-faint transition-colors hover:bg-graphite-700 hover:text-cream"
          >
            <IconEye />
          </button>
          <button
            onClick={() => onDownload?.(node)}
            title="Скачать"
            className="grid h-6 w-6 place-items-center rounded text-cream-faint transition-colors hover:bg-graphite-700 hover:text-cream"
          >
            <IconDownload />
          </button>
          <button
            onClick={() => onDelete?.(node)}
            title="Удалить файл из Workspace"
            className="grid h-6 w-6 place-items-center rounded text-cream-faint transition-colors hover:bg-red-500/10 hover:text-red-300"
          >
            <IconTrash />
          </button>
        </div>
      </div>
    </li>
  )
}

export default function FileTree(props) {
  const { data = [], ...rest } = props
  return (
    <ul className="select-none">
      {data.map((node) => (
        <Row key={node.path || node.name} node={node} depth={0} {...rest} />
      ))}
    </ul>
  )
}
