/**
 * arenaCookieRefresher.js
 * High-durability refresher for VPS: 
 * - Multi-token support (round-robin)
 * - Token history/fallback
 * - Auto-sync with local Bridge config
 */
import fs from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = 'https://huogzoeqzcrdvkwtvodi.supabase.co';
const DEFAULT_ANON_KEY = process.env.ARENA_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRha2VjaGFyZ2UiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTY4MDAwMDAwMCwiZXhwIjoxOTk1NzYwMDAwfQ.8RhjC9S7xYZw8L3fXr9kQ2tZ5mLn7PqX';

function log(...a) { console.log('[arena-survival]', ...a); }

const HISTORY_FILE = '/data/token_history.json';

function saveToHistory(token) {
    try {
        let history = [];
        if (fs.existsSync(HISTORY_FILE)) {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
        if (!history.includes(token)) {
            history.unshift(token);
            // Keep last 5 tokens
            history = history.slice(0, 5);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 4));
        }
    } catch (e) { log('History save failed:', e.message); }
}

async function updateBridgeConfigFile(newCookie) {
  const configPath = process.env.BRIDGE_CONFIG_PATH || '/root/browserai/bridge_config/config.json';
  if (!fs.existsSync(configPath)) return;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Support multi-token in bridge too
    if (!Array.isArray(config.auth_tokens)) config.auth_tokens = [];
    if (!config.auth_tokens.includes(newCookie)) {
        config.auth_tokens.unshift(newCookie);
        config.auth_tokens = config.auth_tokens.slice(0, 5);
    }
    config.auth_token = newCookie;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    log('✅ Bridge config updated with fresh token');
  } catch (e) { log('❌ Bridge update failed:', e.message); }
}

async function refreshSupabaseToken(currentCookie) {
  const anonKey = DEFAULT_ANON_KEY;
  const data = decodeCookie(currentCookie);
  const refreshToken = data?.refresh_token || process.env.ARENA_REFRESH_TOKEN;
  
  if (!refreshToken) {
      log('No refresh token found for session');
      return currentCookie;
  }

  const endpoints = [
      'https://auth.arena.ai/auth/v1/token?grant_type=refresh_token',
      'https://huogzoeqzcrdvkwtvodi.supabase.co/auth/v1/token?grant_type=refresh_token'
  ];

  for (const url of endpoints) {
      try {
        log(`Attempting refresh via ${new URL(url).hostname}...`);
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });

        if (resp.ok) {
            const newSession = await resp.json();
            const newCookie = 'base64-' + Buffer.from(JSON.stringify(newSession)).toString('base64');
            log('✅ Refresh successful!');
            saveToHistory(newCookie);
            await updateBridgeConfigFile(newCookie);
            return newCookie;
        } else {
            log(`Endpoint ${url} failed: ${resp.status}`);
        }
      } catch (e) {
        log(`Network error for ${url}:`, e.message);
      }
  }

  return currentCookie;
}

function decodeCookie(cookie) {
  try {
    const val = cookie.startsWith('base64-') ? cookie.slice(7) : cookie;
    return JSON.parse(Buffer.from(val, 'base64').toString('utf8'));
  } catch { return null; }
}

async function refreshAndUpdateBridgeCookie(currentCookie) {
  return await refreshSupabaseToken(currentCookie);
}

export { refreshSupabaseToken, refreshAndUpdateBridgeCookie, decodeCookie };