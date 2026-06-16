/**
 * shellSession.js
 *
 * Per-chat persistent bash sessions + background-task registry.
 *
 * Why: the legacy runSandboxCommand spawns a fresh `docker exec sh -c`
 * every call. State doesn't persist — `cd`, env vars, activated
 * virtualenvs, exported PATH — all gone the next call. Long-running
 * commands (dev servers, watchers) block the agent loop.
 *
 * What this gives the agent:
 *
 *   • runInSession({chatId, command, …}) — runs INSIDE a long-lived
 *     `docker exec sh` per chat. cwd, env, aliases, even shopt settings
 *     persist across calls. Looks exactly like a real terminal.
 *
 *   • startBackgroundTask({chatId, command, name}) — spawns the command,
 *     returns a handle immediately, captures stdout/stderr to a ring
 *     buffer. Agent can use readBackgroundLogs / stopBackgroundTask
 *     later. Perfect for `npm run dev`, `tail -F app.log &`, etc.
 *
 *   • listBackgroundTasks() — for the UI / for the agent to see what's
 *     still running.
 *
 * Implementation strategy:
 *   We open ONE persistent `docker exec -i agent-sandbox bash` per chat,
 *   write the command followed by a sentinel echo `__BAEND__$?` so we
 *   can detect end-of-command + capture the exit code. Output collected
 *   between two sentinels = the command's output. Cheap, robust, no
 *   need to involve a third-party PTY library.
 */
import { spawn } from 'node:child_process'
import { getSandboxContainer, getSandboxEnv } from './agentSandbox.js'

// One session per chatId. Closed automatically after IDLE_TIMEOUT_MS
// of inactivity (keep memory bounded across many old chats).
const SESSIONS = new Map() // chatId → { proc, queue, busy, lastUsed, closeTimer, alive }
const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 min

// Background tasks: spawned via startBackgroundTask, polled via
// readBackgroundLogs. Map of taskId → { name, command, proc, stdout,
// stderr, exitCode, startedAt, finishedAt, chatId }
const BG_TASKS = new Map()
const BG_RING_SIZE = 16 * 1024  // per-stream

function makeSentinel() {
  return '__BA' + Math.random().toString(36).slice(2, 10).toUpperCase() + 'END__'
}

async function openSession(chatId, cwd = '/workspace') {
  const sandboxContainer = await getSandboxContainer()
  const envs = getSandboxEnv()
  const args = [
    'exec', '-i',
    '--user', process.env.AGENT_SANDBOX_USER || '0:0',
  ]
  for (const [k, v] of Object.entries(envs)) {
    args.push('-e', `${k}=${v}`)
  }
  args.push(
    '-w', cwd,
    sandboxContainer,
    'bash', '--noprofile', '--norc',
  )
  const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const session = {
    chatId,
    proc,
    queue: [],
    busy: false,
    lastUsed: Date.now(),
    closeTimer: null,
    alive: true,
  }
  proc.on('exit', () => { session.alive = false; SESSIONS.delete(chatId) })
  proc.on('error', () => { session.alive = false; SESSIONS.delete(chatId) })
  // Disable readline-style echo so we never see our own commands back.
  proc.stdin.write('stty -echo 2>/dev/null; export PS1=""; export PROMPT_COMMAND=""\n')
  SESSIONS.set(chatId, session)
  scheduleIdleClose(session)
  return session
}

function scheduleIdleClose(session) {
  if (session.closeTimer) clearTimeout(session.closeTimer)
  session.closeTimer = setTimeout(() => {
    if (!session.alive) return
    if (Date.now() - session.lastUsed < IDLE_TIMEOUT_MS) {
      scheduleIdleClose(session)
      return
    }
    try { session.proc.stdin.write('exit\n') } catch { /* ignore */ }
    setTimeout(() => { try { session.proc.kill('SIGKILL') } catch { /* ignore */ } }, 500)
  }, IDLE_TIMEOUT_MS)
  session.closeTimer.unref?.()
}

/**
 * Run a command in the persistent session for this chatId. Queues if
 * a previous command is still running.
 *
 * Returns { stdout, stderr, exitCode, durationMs, sessionId }.
 */
export async function runInSession({ chatId, command, timeoutMs = 60_000, signal, onStdout, onStderr } = {}) {
  if (!chatId)                          return Promise.reject(new Error('chatId required'))
  if (typeof command !== 'string' || !command) return Promise.reject(new Error('command must be a non-empty string'))

  let session = SESSIONS.get(chatId)
  if (!session || !session.alive) {
    const cwd = arguments[0]?.cwd || '/workspace'
    session = await openSession(chatId, cwd)
  }

  return new Promise((resolve, reject) => {
    const job = { command, timeoutMs, signal, onStdout, onStderr, resolve, reject }
    session.queue.push(job)
    if (!session.busy) processQueue(session)
  })
}

function processQueue(session) {
  if (session.busy) return
  const job = session.queue.shift()
  if (!job) return
  session.busy = true
  session.lastUsed = Date.now()

  const sentOut = makeSentinel()
  const startedAt = Date.now()

  let outBuf = ''
  let stdoutClipped = ''
  let stderrClipped = ''
  let killed = false
  let cancelled = false
  let resolved = false

  const onStdoutData = (chunk) => {
    const s = chunk.toString('utf8')
    outBuf += s
    // Pass live output to caller, but strip our sentinel if it lands
    // inside this chunk so the user never sees it on screen.
    const visible = s.replace(new RegExp(sentOut + '\\d+', 'g'), '')
    if (visible && job.onStdout) {
      try { job.onStdout(visible) } catch { /* ignore */ }
    }
    if (stdoutClipped.length < 12_000) stdoutClipped = (stdoutClipped + visible).slice(0, 12_000)
    checkDone()
  }
  const onStderrData = (chunk) => {
    const s = chunk.toString('utf8')
    if (job.onStderr) { try { job.onStderr(s) } catch { /* ignore */ } }
    if (stderrClipped.length < 6_000) stderrClipped = (stderrClipped + s).slice(0, 6_000)
  }

  session.proc.stdout.on('data', onStdoutData)
  session.proc.stderr.on('data', onStderrData)

  // Sentinel-based end-of-command detection. We append:
  //   ; printf "\n${sentOut}%d\n" $?
  // which prints the sentinel + exit code on a line of its own when the
  // user's command finishes. Regex extracts the exit code; truncates
  // the sentinel out of the visible buffer.
  const sentinelRe = new RegExp(sentOut + '(\\d+)')

  function checkDone() {
    if (resolved) return
    const m = sentinelRe.exec(outBuf)
    if (!m) return
    resolved = true
    const exitCode = Number(m[1])
    cleanup()
    const stdout = stdoutClipped.replace(sentinelRe, '').replace(/[\r\n]+$/, '')
    const stderr = stderrClipped.replace(/[\r\n]+$/, '')
    job.resolve({
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
      sessionId: session.chatId,
      cancelled,
      killed,
    })
    session.busy = false
    processQueue(session)
  }

  function cleanup() {
    clearTimeout(timer)
    session.proc.stdout.off('data', onStdoutData)
    session.proc.stderr.off('data', onStderrData)
    if (onAbort && job.signal) job.signal.removeEventListener('abort', onAbort)
  }

  const timer = setTimeout(() => {
    if (resolved) return
    killed = true
    // Send Ctrl-C to interrupt the current command but keep the session
    // alive — the user's `cd` and env stay intact for the next run.
    try { session.proc.stdin.write('\x03') } catch { /* ignore */ }
    // Give the sentinel a chance to land; if it doesn't in 2s, hard-resolve.
    setTimeout(() => {
      if (resolved) return
      resolved = true
      cleanup()
      job.resolve({
        stdout: stdoutClipped,
        stderr: stderrClipped + `\n[shellSession] killed after ${job.timeoutMs}ms timeout`,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        sessionId: session.chatId,
        cancelled: false,
        killed: true,
      })
      session.busy = false
      processQueue(session)
    }, 2000)
  }, job.timeoutMs)

  let onAbort = null
  if (job.signal) {
    onAbort = () => {
      cancelled = true
      try { session.proc.stdin.write('\x03') } catch { /* ignore */ }
    }
    if (job.signal.aborted) onAbort()
    else job.signal.addEventListener('abort', onAbort, { once: true })
  }

  // Write the actual command + sentinel-emitting epilogue.
  const payload = `${job.command}\nprintf "\\n${sentOut}%d\\n" $?\n`
  try { session.proc.stdin.write(payload) }
  catch (e) {
    resolved = true; cleanup()
    job.reject(new Error('shell session closed: ' + e.message))
    session.busy = false
    processQueue(session)
  }
}

/**
 * Reset a session — kill it; the next runInSession will reopen fresh.
 */
export function resetSession(chatId) {
  const s = SESSIONS.get(chatId)
  if (!s) return false
  try { s.proc.kill('SIGKILL') } catch { /* ignore */ }
  SESSIONS.delete(chatId)
  return true
}

// ── Background tasks ────────────────────────────────────────────────────────

function genTaskId() {
  return 'bg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

function clipRing(text, max) {
  if (text.length <= max) return text
  return text.slice(-max)
}

/**
 * Spawn a background command. Returns immediately with { taskId }; the
 * command runs in its own `docker exec`, output captured to a ring
 * buffer for later inspection via readBackgroundLogs / listBackgroundTasks.
 */
export async function startBackgroundTask({ chatId = '', command, name = '', cwd = '/workspace' } = {}) {
  if (typeof command !== 'string' || !command) throw new Error('command required')
  const taskId = genTaskId()
  const sandboxContainer = await getSandboxContainer()
  const envs = getSandboxEnv()
  const args = [
    'exec',
    '--user', process.env.AGENT_SANDBOX_USER || '0:0',
  ]
  for (const [k, v] of Object.entries(envs)) {
    args.push('-e', `${k}=${v}`)
  }
  args.push(
    '-w', cwd,
    sandboxContainer,
    'sh', '-c', command,
  )
  const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const task = {
    id: taskId,
    chatId,
    name: name || command.slice(0, 60),
    command,
    proc,
    stdout: '',
    stderr: '',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
  }
  proc.stdout.on('data', (c) => { task.stdout = clipRing(task.stdout + c.toString('utf8'), BG_RING_SIZE) })
  proc.stderr.on('data', (c) => { task.stderr = clipRing(task.stderr + c.toString('utf8'), BG_RING_SIZE) })
  proc.on('exit', (code) => {
    task.exitCode = code == null ? -1 : code
    task.finishedAt = Date.now()
  })
  proc.on('error', (e) => {
    task.stderr = clipRing(task.stderr + '\n[startBackgroundTask] ' + e.message, BG_RING_SIZE)
    task.exitCode = -1
    task.finishedAt = Date.now()
  })
  BG_TASKS.set(taskId, task)
  return { taskId, name: task.name, command: task.command, startedAt: task.startedAt }
}

export function readBackgroundLogs(taskId, { tail = 4000 } = {}) {
  const task = BG_TASKS.get(taskId)
  if (!task) return null
  return {
    id: task.id,
    name: task.name,
    command: task.command,
    chatId: task.chatId,
    stdout: task.stdout.length > tail ? task.stdout.slice(-tail) : task.stdout,
    stderr: task.stderr.length > tail ? task.stderr.slice(-tail) : task.stderr,
    running: task.exitCode == null,
    exitCode: task.exitCode,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    uptimeMs: (task.finishedAt || Date.now()) - task.startedAt,
  }
}

export function stopBackgroundTask(taskId) {
  const task = BG_TASKS.get(taskId)
  if (!task) return false
  try { task.proc.kill('SIGTERM') } catch { /* ignore */ }
  setTimeout(() => { try { task.proc.kill('SIGKILL') } catch { /* ignore */ } }, 1500)
  return true
}

export function listBackgroundTasks(chatId = null) {
  const arr = []
  for (const task of BG_TASKS.values()) {
    if (chatId && task.chatId !== chatId) continue
    arr.push({
      id: task.id,
      name: task.name,
      command: task.command,
      chatId: task.chatId,
      running: task.exitCode == null,
      exitCode: task.exitCode,
      startedAt: task.startedAt,
      uptimeMs: (task.finishedAt || Date.now()) - task.startedAt,
    })
  }
  return arr.sort((a, b) => b.startedAt - a.startedAt)
}

export default {
  runInSession, resetSession,
  startBackgroundTask, readBackgroundLogs, stopBackgroundTask, listBackgroundTasks,
}
