/**
 * arenaCookieRefresher.js
 * Optimized for VPS: auto-updates tokens for local LMArenaBridge.
 */
import fs from 'node:fs';

const SUPABASE_URL = 'https://huogzoeqzcrdvkwtvodi.supabase.co';
const DEFAULT_ANON_KEY = process.env.ARENA_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRha2VjaGFyZ2UiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTY4MDAwMDAwMCwiZXhwIjoxOTk1NzYwMDAwfQ.8RhjC9S7xYZw8L3fXr9kQ2tZ5mLn7PqX';

function log(...a) { console.log('[arena-refresh]', ...a); }

async function updateBridgeConfigFile(newCookie) {
  const configPath = process.env.BRIDGE_CONFIG_PATH || '/root/browserai/bridge_config/config.json';
  if (!fs.existsSync(configPath)) {
    log('Bridge config not found at', configPath, '- skipping file update');
    return;
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.auth_tokens = [newCookie];
    config.auth_token = newCookie;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    log('✅ Updated bridge config file with new token');
  } catch (e) {
    log('❌ Failed to update bridge config file:', e.message);
  }
}

async function refreshSupabaseToken(currentCookie) {
  const anonKey = DEFAULT_ANON_KEY;
  const data = decodeCookie(currentCookie);
  const refreshToken = data?.refresh_token || process.env.ARENA_REFRESH_TOKEN;
  
  if (!refreshToken) return currentCookie;

  log('Refreshing Arena session via Supabase...');
  try {
    // Try user suggested endpoint first
    let resp = await fetch(`https://auth.arena.ai/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    // Fallback to standard Supabase URL if 404
    if (!resp.ok) {
        log('auth.arena.ai failed, trying fallback supabase url...');
        resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
    }

    if (!resp.ok) {
        log('Refresh failed:', resp.status);
        return currentCookie;
    }
    
    const newSession = await resp.json();
    const newCookie = 'base64-' + Buffer.from(JSON.stringify(newSession)).toString('base64');
    log('✅ Session refreshed. New expires:', new Date((newSession.expires_at || 0) * 1000).toISOString());
    
    // Push to bridge file
    await updateBridgeConfigFile(newCookie);
    
    return newCookie;
  } catch (e) {
    log('Refresh error:', e.message);
    return currentCookie;
  }
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