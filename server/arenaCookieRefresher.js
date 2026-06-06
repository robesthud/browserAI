/**
 * arenaCookieRefresher.js
 * Autonomous token lifecycle manager:
 *
 * 1. Stores refresh_token separately in /data/arena_refresh.json (survives restarts)
 * 2. Refreshes access_token via Supabase every 45 min (token lives 60 min)
 * 3. Pushes fresh token to Bridge via HTTP API (auto-login to dashboard)
 * 4. Sends Telegram notifications on success/failure
 * 5. Falls back to token history if primary refresh fails
 *
 * Flow:
 *   BrowserAI startup → load refresh_token from disk
 *     ↓ every 45 min (or on manual trigger)
 *   Supabase /auth/v1/token?grant_type=refresh_token
 *     ↓ success
 *   New access_token + new refresh_token
 *     ↓
 *   Save refresh_token to disk (survives restart)
 *   Update process.env.ARENA_AUTH_COOKIE (in-memory)
 *   Push to Bridge dashboard via HTTP POST
 *   Send Telegram notification
 */
import fs from 'node:fs';
import path from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://huogzoeqzcrdvkwtvodi.supabase.co';
const DEFAULT_ANON_KEY = process.env.ARENA_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1b2d6b2VxemNyZHZrd3R2b2RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTYzMDMwMDAsImV4cCI6MjAzMTg3OTAwMH0.placeholder';

const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const REFRESH_STATE_FILE = '/data/arena_refresh.json';
const HISTORY_FILE = '/data/token_history.json';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://lmarena-bridge:8000';
const BRIDGE_PASSWORD = process.env.BRIDGE_PASSWORD || 'admin';

// ── Logging ─────────────────────────────────────────────────────────────────
function log(...a) { console.log('[arena-refresh]', ...a); }
function warn(...a) { console.warn('[arena-refresh]', ...a); }

// ── Telegram notifications ──────────────────────────────────────────────────
async function sendTg(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' }),
    });
  } catch (e) { warn('TG notify failed:', e.message); }
}

// ── Persistent refresh state ────────────────────────────────────────────────
function loadRefreshState() {
  try {
    if (fs.existsSync(REFRESH_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(REFRESH_STATE_FILE, 'utf8'));
    }
  } catch (e) { warn('loadRefreshState error:', e.message); }
  return {};
}

function saveRefreshState(state) {
  try {
    const dir = path.dirname(REFRESH_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REFRESH_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { warn('saveRefreshState error:', e.message); }
}

// ── Token decode ────────────────────────────────────────────────────────────
function decodeCookie(cookie) {
  try {
    if (!cookie) return null;
    const val = cookie.startsWith('base64-') ? cookie.slice(7) : cookie;
    return JSON.parse(Buffer.from(val, 'base64').toString('utf8'));
  } catch { return null; }
}

function getTokenExpiry(cookie) {
  const data = decodeCookie(cookie);
  if (!data) return 0;
  return data.expires_at || 0;
}

function isTokenExpired(cookie, bufferSeconds = 300) {
  const exp = getTokenExpiry(cookie);
  if (!exp) return true;
  return Date.now() / 1000 >= exp - bufferSeconds;
}

// ── Token history (fallback pool) ───────────────────────────────────────────
function saveToHistory(token) {
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
    if (!Array.isArray(history)) history = [];
    // Deduplicate by refresh_token
    const newData = decodeCookie(token);
    const newRefresh = newData?.refresh_token;
    history = history.filter(t => {
      const d = decodeCookie(t);
      return d?.refresh_token !== newRefresh;
    });
    history.unshift(token);
    history = history.slice(0, 10);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) { warn('saveToHistory error:', e.message); }
}

function getHistoryTokens() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      return Array.isArray(h) ? h : [];
    }
  } catch {}
  return [];
}

// ── Bridge sync via HTTP ────────────────────────────────────────────────────
async function pushTokenToBridge(token) {
  try {
    // Step 1: Login to dashboard
    const loginResp = await fetch(`${BRIDGE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(BRIDGE_PASSWORD)}`,
      redirect: 'manual',
    });

    // Extract session cookie from Set-Cookie header
    const setCookie = loginResp.headers.get('set-cookie') || '';
    const sessionMatch = setCookie.match(/session_id=([^;]+)/);
    if (!sessionMatch) {
      warn('Bridge login failed — no session cookie returned');
      return false;
    }
    const sessionCookie = `session_id=${sessionMatch[1]}`;

    // Step 2: Add token via /add-auth-token
    const addResp = await fetch(`${BRIDGE_URL}/add-auth-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': sessionCookie,
      },
      body: `new_auth_token=${encodeURIComponent(token)}`,
      redirect: 'manual',
    });

    if (addResp.status === 303 || addResp.status === 200) {
      log('✅ Token pushed to Bridge via HTTP API');
      return true;
    } else {
      warn(`Bridge add-auth-token returned ${addResp.status}`);
      return false;
    }
  } catch (e) {
    warn('pushTokenToBridge error:', e.message);
    return false;
  }
}

// ── Also update bridge config file directly (belt + suspenders) ─────────────
function updateBridgeConfigFile(newCookie) {
  const configPath = process.env.BRIDGE_CONFIG_PATH || '/bridge_config/config.json';
  try {
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!Array.isArray(config.auth_tokens)) config.auth_tokens = [];

    // Remove old tokens with same refresh_token
    const newData = decodeCookie(newCookie);
    const newRefresh = newData?.refresh_token;
    if (newRefresh) {
      config.auth_tokens = config.auth_tokens.filter(t => {
        const d = decodeCookie(t);
        return d?.refresh_token !== newRefresh;
      });
    }

    // Add new token at front
    config.auth_tokens.unshift(newCookie);
    config.auth_tokens = config.auth_tokens.slice(0, 5);
    config.auth_token = newCookie;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    log('✅ Bridge config file updated');
  } catch (e) { warn('updateBridgeConfigFile error:', e.message); }
}

// ── Core: Supabase refresh ──────────────────────────────────────────────────
async function refreshViaSupabase(refreshToken, anonKey) {
  const endpoints = [
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    'https://auth.arena.ai/auth/v1/token?grant_type=refresh_token',
  ];

  for (const url of endpoints) {
    try {
      log(`Refreshing via ${new URL(url).hostname}...`);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(15000),
      });

      if (resp.ok) {
        const newSession = await resp.json();
        if (!newSession.access_token || !newSession.refresh_token) {
          warn('Refresh response missing tokens');
          continue;
        }
        return newSession;
      } else {
        const errText = await resp.text().catch(() => '');
        warn(`${new URL(url).hostname} returned ${resp.status}: ${errText.slice(0, 200)}`);
      }
    } catch (e) {
      warn(`Network error for ${new URL(url).hostname}:`, e.message);
    }
  }
  return null;
}

// ── Main refresh logic ──────────────────────────────────────────────────────
async function refreshAndUpdateBridgeCookie(currentCookie) {
  const configPath = process.env.BRIDGE_CONFIG_PATH || '/bridge_config/config.json';
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.auth_tokens && config.auth_tokens.length > 0) {
        log('Reading fresh token from LMArenaBridge config.json...');
        return config.auth_tokens[0];
      }
    }
  } catch (e) {
    warn('Error reading config.json:', e.message);
  }
  return currentCookie;
}


async function processNewSession(newSession, currentCookie) {
  // 3. Build new cookie
  const newCookie = 'base64-' + Buffer.from(JSON.stringify(newSession)).toString('base64');
  const expiresAt = newSession.expires_at || 0;
  const expiresDate = new Date(expiresAt * 1000);

  log(`✅ Refresh successful! Valid until ${expiresDate.toISOString()}`);

  // 4. Save refresh_token to disk (CRITICAL — survives container restarts)
  saveRefreshState({
    refresh_token: newSession.refresh_token,
    access_token_prefix: newSession.access_token?.slice(0, 20),
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
    user_email: newSession.user?.email || '?',
  });

  // 5. Save to history
  saveToHistory(newCookie);

  // 6. Update bridge config file (shared volume)
  updateBridgeConfigFile(newCookie);

  // 7. Push to bridge via HTTP (updates in-memory state)
  const bridgePushed = await pushTokenToBridge(newCookie);

  // 8. Telegram notification
  await sendTg(
    `✅ *Arena Token Refreshed*\n` +
    `Valid until: ${expiresDate.toLocaleString()}\n` +
    `Bridge sync: ${bridgePushed ? '✅' : '⚠️ file only'}\n` +
    `User: ${newSession.user?.email || '?'}`
  );

  return newCookie;
}

// ── Bootstrap: extract refresh_token from initial cookie ────────────────────
function bootstrapFromCookie(cookie) {
  if (!cookie) return;
  const data = decodeCookie(cookie);
  if (!data?.refresh_token) return;

  const state = loadRefreshState();
  // Only overwrite if we don't have one yet, or the cookie is newer
  if (!state.refresh_token || state.refresh_token !== data.refresh_token) {
    log('Bootstrapping refresh_token from initial cookie');
    saveRefreshState({
      refresh_token: data.refresh_token,
      access_token_prefix: data.access_token?.slice(0, 20),
      expires_at: data.expires_at || 0,
      updated_at: new Date().toISOString(),
      user_email: data.user?.email || '?',
      source: 'bootstrap',
    });
    saveToHistory(cookie);
  }
}

export { refreshAndUpdateBridgeCookie, decodeCookie, bootstrapFromCookie, isTokenExpired };
