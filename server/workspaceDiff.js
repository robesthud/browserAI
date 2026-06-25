const DEFAULT_CONTEXT = 3
const MAX_DIFF_LINES = Number(process.env.WORKSPACE_DIFF_MAX_LINES || 240)

function splitLines(text = '') {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized) return []
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
}

function countLines(text = '') {
  const s = String(text ?? '')
  if (!s) return 0
  return splitLines(s).length
}

function lcsMatrix(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return dp
}

function diffOps(oldLines, newLines) {
  const dp = lcsMatrix(oldLines, newLines)
  const ops = []
  let i = 0, j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) { ops.push([' ', oldLines[i]]); i += 1; j += 1 }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', oldLines[i]]); i += 1 }
    else { ops.push(['+', newLines[j]]); j += 1 }
  }
  while (i < oldLines.length) { ops.push(['-', oldLines[i]]); i += 1 }
  while (j < newLines.length) { ops.push(['+', newLines[j]]); j += 1 }
  return ops
}

function compactOps(ops, context = DEFAULT_CONTEXT) {
  const changed = ops.map((op, idx) => op[0] !== ' ' ? idx : -1).filter((idx) => idx >= 0)
  if (!changed.length) return []
  const keep = new Set()
  for (const idx of changed) {
    for (let i = Math.max(0, idx - context); i <= Math.min(ops.length - 1, idx + context); i += 1) keep.add(i)
  }
  const out = []
  let last = -2
  for (const idx of [...keep].sort((a, b) => a - b)) {
    if (idx > last + 1 && out.length) out.push(['…', ''])
    out.push(ops[idx])
    last = idx
  }
  return out
}

export function createUnifiedDiff({ path = 'file', before = '', after = '', type = 'modified', context = DEFAULT_CONTEXT } = {}) {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const ops = compactOps(diffOps(oldLines, newLines), context)
  let truncated = false
  let shown = ops
  if (ops.length > MAX_DIFF_LINES) {
    shown = ops.slice(0, MAX_DIFF_LINES)
    shown.push(['…', `diff truncated: ${ops.length - MAX_DIFF_LINES} more lines`])
    truncated = true
  }
  const headerOld = type === 'created' ? '/dev/null' : `a/${path}`
  const headerNew = type === 'deleted' ? '/dev/null' : `b/${path}`
  const patch = [
    `--- ${headerOld}`,
    `+++ ${headerNew}`,
    `@@ ${type} @@`,
    ...shown.map(([tag, line]) => tag === '…' ? `… ${line}` : `${tag}${line}`),
  ].join('\n')
  return {
    path,
    type,
    oldLines: countLines(before),
    newLines: countLines(after),
    patch,
    truncated,
  }
}

export function diffForTextChange(path, before, after, type = 'modified') {
  return createUnifiedDiff({ path, before, after, type })
}

export default createUnifiedDiff
