/**
 * computerUse.js
 *
 * Computer Use tool implementations — control a virtual X11 desktop
 * inside the `computer-sandbox` Docker container via xdotool / scrot.
 *
 * Mirrors Claude's Computer Use tool API (Anthropic / Arena style):
 *   computer_screenshot()                 → PNG of the current screen
 *   computer_click(x, y, button)          → mouse click at coords
 *   computer_double_click(x, y)           → double click
 *   computer_type(text)                   → typed input into focused window
 *   computer_key(key)                     → keypress / chord (e.g. 'ctrl+l')
 *   computer_scroll(x, y, direction, n)   → wheel scroll
 *   computer_move(x, y)                   → move mouse without clicking
 *   computer_open_app(name, url?)         → spawn firefox / xterm / …
 *   computer_status()                     → diagnostics
 *
 * All operations dispatch via `docker exec computer-sandbox …` and
 * surface their output / screenshot back to the agent loop in a single
 * round-trip.
 */
import { spawn } from 'node:child_process'

const SANDBOX = process.env.COMPUTER_SANDBOX_CONTAINER || 'computer-sandbox'

function execInContainer(args, { timeoutMs = 15_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', SANDBOX, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let killed = false
    const timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
    let onAbort
    if (signal) {
      onAbort = () => { killed = true; try { proc.kill('SIGKILL') } catch { /* ignore */ } }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    proc.stdout.on('data', (c) => out.push(c))
    proc.stderr.on('data', (c) => err.push(c))
    proc.on('error', (e) => {
      clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      reject(new Error(`docker exec failed: ${e.message}. Is computer-sandbox running? (docker compose --profile computer up -d computer-sandbox)`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: killed ? -1 : code,
        killed,
      })
    })
  })
}

function execShell(command, opts = {}) {
  return execInContainer(['bash', '-lc', command], opts)
}

async function ensureDisplay() {
  const enabled = String(process.env.BROWSERAI_COMPUTER_USE || '').toLowerCase() === 'on'
  if (!enabled) {
    throw new Error('Computer Use is DISABLED. Please set BROWSERAI_COMPUTER_USE=on in the .env file and restart the server.')
  }
  
  const r = await execShell('DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && echo ok || echo MISSING', { timeoutMs: 5_000 })
  const ok = r.stdout.toString().trim() === 'ok'
  if (!ok) {
    throw new Error('computer-sandbox display :99 is not ready. Ensure the computer-sandbox container is running: `docker compose --profile computer up -d computer-sandbox`.')
  }
}

// ── Screenshot ──────────────────────────────────────────────────────────────
export async function computerScreenshot({ signal } = {}) {
  await ensureDisplay()
  // scrot writes PNG to stdout when path is '-'; that's the cleanest way
  // to ship pixels back without leaving files in the sandbox.
  const r = await execShell('DISPLAY=:99 scrot -o /tmp/screenshots/last.png && base64 -w0 /tmp/screenshots/last.png', { signal, timeoutMs: 10_000 })
  if (r.exitCode !== 0) {
    return { ok: false, error: `scrot failed: ${r.stderr || 'unknown'}` }
  }
  const b64 = r.stdout.toString('utf8').trim()
  if (!b64) return { ok: false, error: 'empty screenshot output' }
  return {
    ok: true,
    mime: 'image/png',
    width: Number(process.env.COMPUTER_SCREEN_WIDTH || 1280),
    height: Number(process.env.COMPUTER_SCREEN_HEIGHT || 720),
    bytes: Math.floor(b64.length * 3 / 4),
    dataUrl: `data:image/png;base64,${b64}`,
  }
}

// ── Mouse ───────────────────────────────────────────────────────────────────
function buttonCode(b = 'left') {
  const map = { left: 1, middle: 2, right: 3, scroll_up: 4, scroll_down: 5 }
  return map[String(b).toLowerCase()] || 1
}

export async function computerClick({ x, y, button = 'left', signal } = {}) {
  await ensureDisplay()
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'x, y are required (integers)' }
  const r = await execShell(`DISPLAY=:99 xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} click ${buttonCode(button)}`, { signal })
  if (r.exitCode !== 0) return { ok: false, error: `xdotool click failed: ${r.stderr || 'unknown'}` }
  // Return a fresh screenshot so the agent sees the effect of the click.
  const shot = await computerScreenshot({ signal }).catch(() => null)
  return { ok: true, action: 'click', x, y, button, dataUrl: shot?.dataUrl || null }
}

export async function computerDoubleClick({ x, y, signal } = {}) {
  await ensureDisplay()
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'x, y are required' }
  const r = await execShell(`DISPLAY=:99 xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} click --repeat 2 --delay 60 1`, { signal })
  if (r.exitCode !== 0) return { ok: false, error: r.stderr || 'double-click failed' }
  const shot = await computerScreenshot({ signal }).catch(() => null)
  return { ok: true, action: 'double_click', x, y, dataUrl: shot?.dataUrl || null }
}

export async function computerMove({ x, y, signal } = {}) {
  await ensureDisplay()
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'x, y are required' }
  const r = await execShell(`DISPLAY=:99 xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)}`, { signal })
  if (r.exitCode !== 0) return { ok: false, error: r.stderr || 'mousemove failed' }
  return { ok: true, action: 'move', x, y }
}

export async function computerScroll({ x, y, direction = 'down', amount = 3, signal } = {}) {
  await ensureDisplay()
  const btn = String(direction).toLowerCase() === 'up' ? 4 : 5
  const n = Math.max(1, Math.min(20, Number(amount) || 3))
  let cmd = 'DISPLAY=:99 '
  if (Number.isFinite(x) && Number.isFinite(y)) {
    cmd += `xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} `
  } else {
    cmd += `xdotool `
  }
  cmd += `click --repeat ${n} --delay 30 ${btn}`
  const r = await execShell(cmd, { signal })
  if (r.exitCode !== 0) return { ok: false, error: r.stderr || 'scroll failed' }
  const shot = await computerScreenshot({ signal }).catch(() => null)
  return { ok: true, action: 'scroll', direction, amount: n, dataUrl: shot?.dataUrl || null }
}

// ── Keyboard ────────────────────────────────────────────────────────────────
export async function computerType({ text, signal } = {}) {
  await ensureDisplay()
  if (typeof text !== 'string' || !text.length) return { ok: false, error: 'text is required' }
  // xdotool type --delay slows the synthetic typing so apps that miss keys
  // on bursts (e.g. some web inputs) catch every char. Up to 5000 chars.
  const safe = text.slice(0, 5000)
  // Pass via stdin to avoid shell quoting nightmares.
  return new Promise((resolve) => {
    const proc = spawn('docker', ['exec', '-i', SANDBOX, 'bash', '-lc', 'DISPLAY=:99 xdotool type --delay 20 --file -'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (c) => { err += c.toString('utf8') })
    let onAbort
    if (signal) {
      onAbort = () => { try { proc.kill('SIGKILL') } catch { /* ignore */ } }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    proc.on('close', async (code) => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      if (code !== 0) { resolve({ ok: false, error: err || 'xdotool type failed' }); return }
      const shot = await computerScreenshot({ signal }).catch(() => null)
      resolve({ ok: true, action: 'type', chars: safe.length, dataUrl: shot?.dataUrl || null })
    })
    proc.stdin.end(safe)
  })
}

// xdotool 'key' uses X11 keysym names: Return, BackSpace, Tab, Escape,
// ctrl+a, ctrl+shift+t, etc.
export async function computerKey({ key, signal } = {}) {
  await ensureDisplay()
  if (typeof key !== 'string' || !key) return { ok: false, error: 'key is required (e.g. "Return", "ctrl+l")' }
  // Sanitise — only allow letters/digits/+/_/- to land on the command line.
  if (!/^[A-Za-z0-9+_-]+$/.test(key)) return { ok: false, error: `unsafe key syntax: ${key}` }
  const r = await execShell(`DISPLAY=:99 xdotool key --delay 30 ${key}`, { signal })
  if (r.exitCode !== 0) return { ok: false, error: r.stderr || 'xdotool key failed' }
  const shot = await computerScreenshot({ signal }).catch(() => null)
  return { ok: true, action: 'key', key, dataUrl: shot?.dataUrl || null }
}

// ── App launch ──────────────────────────────────────────────────────────────
const ALLOWED_APPS = new Set(['firefox', 'firefox-esr', 'xterm'])

export async function computerOpenApp({ name = 'firefox', url = '', signal } = {}) {
  await ensureDisplay()
  const app = String(name).toLowerCase().trim()
  if (!ALLOWED_APPS.has(app)) {
    return { ok: false, error: `app not allowed: ${app}. Allowed: ${[...ALLOWED_APPS].join(', ')}` }
  }
  // Run detached: nohup … & so xdotool can keep working while the app is up.
  let cmd
  if (app === 'firefox' || app === 'firefox-esr') {
    const safeUrl = url && /^https?:\/\//i.test(url) ? url : 'about:blank'
    // --no-remote --new-instance keeps each invocation a fresh profile
    // so the agent doesn't trip over previous-session restore prompts.
    cmd = `DISPLAY=:99 nohup firefox-esr --no-remote --new-instance "${safeUrl.replace(/"/g, '\\"')}" >/tmp/${app}.log 2>&1 &`
  } else {
    cmd = `DISPLAY=:99 nohup ${app} >/tmp/${app}.log 2>&1 &`
  }
  const r = await execShell(cmd, { signal, timeoutMs: 8_000 })
  if (r.exitCode !== 0) return { ok: false, error: r.stderr || `failed to spawn ${app}` }
  // Give the window 1.5s to render before we screenshot.
  await new Promise((r2) => setTimeout(r2, 1500))
  const shot = await computerScreenshot({ signal }).catch(() => null)
  return { ok: true, action: 'open_app', app, url: url || null, dataUrl: shot?.dataUrl || null }
}

// ── Status / diagnostics ────────────────────────────────────────────────────
export async function computerStatus({ signal } = {}) {
  try {
    await ensureDisplay()
    const r = await execShell('DISPLAY=:99 xdotool getmouselocation 2>/dev/null; DISPLAY=:99 wmctrl -l 2>/dev/null || true; DISPLAY=:99 xrandr 2>/dev/null | head -3', { signal })
    return { ok: true, ready: true, info: r.stdout.toString('utf8').slice(0, 2000) }
  } catch (e) {
    return { ok: false, error: e?.message || String(e), ready: false }
  }
}

export default {
  computerScreenshot,
  computerClick, computerDoubleClick, computerMove, computerScroll,
  computerType, computerKey,
  computerOpenApp, computerStatus,
}
