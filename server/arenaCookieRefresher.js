/**
 * arenaCookieRefresher.js
 * Minimal pure token refresh for Arena cookie (no browser, no Playwright).
 * Used to auto-update cookie for the external LMArenaBridge service.
 */

const SUPABASE_URL = 'https://huogzoeqzcrdvkwtvodi.supabase.co';

// Hardcoded anon key for the project (from original setup). Can be overridden by env.
const DEFAULT_ANON_KEY = process.env.ARENA_ANON_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1b2d6b2VxenNyZHZrd3R2b2RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDEyNzQ0MDAsImV4cCI6MjAxNjg1MDQwMH0.3_UBk2U1v1us4zkNMYZOjYfYF6LGd1FlpgLZaMmvPkuC8rr2hlY4onOByQFZuK7txCfIVqR3X8DtQnrttzKmFeww';

function log(...a) { console.log('[arena-refresh]', ...a); }
function warn(...a) { console.warn('[arena-refresh]', ...a); }

function decodeCookie(cookie) {
  try {
    const val = cookie.startsWith('base64-') ? cookie.slice(7) : cookie;
    const padded = val + '='.repeat((4 - val.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch { return null; }
}

async function refreshSupabaseToken(currentCookie) {
  const anonKey = DEFAULT_ANON_KEY;
  if (!anonKey) {
    warn('No ARENA_ANON_KEY');
    return currentCookie;
  }

  const data = decodeCookie(currentCookie);
  let refreshToken = data?.refresh_token;
  if (!refreshToken && process.env.ARENA_REFRESH_TOKEN) {
    refreshToken = process.env.ARENA_REFRESH_TOKEN;
  }
  if (!refreshToken) {
    warn('No refresh_token found in cookie or env');
    return currentCookie;
  }

  log('Refreshing Supabase token for bridge...');
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!resp.ok) {
      warn('Supabase refresh failed:', resp.status, (await resp.text().catch(() => '')).slice(0, 100));
      return currentCookie;
    }
    const newSession = await resp.json();
    const newCookie = 'base64-' + Buffer.from(JSON.stringify(newSession)).toString('base64');
    log('✅ Cookie refreshed successfully. New expires:', new Date((newSession.expires_at || 0) * 1000).toISOString());
    return newCookie;
  } catch (e) {
    warn('Refresh error:', e.message);
    return currentCookie;
  }
}

// Update the cookie in the lmarena-bridge Railway service via API
async function updateBridgeServiceCookie(newCookie) {
  const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (!RAILWAY_TOKEN) {
    warn('No RAILWAY_API_TOKEN for updating bridge service');
    return false;
  }

  const projectId = 'd40e6637-c07a-4fd4-bba9-caff5f0bd231';
  const envId = '3e760881-7301-4390-a2ea-e125dedd862c';
  const bridgeServiceId = '7dba1298-16dc-4eee-8ce7-e26886730934';

  try {
    const resp = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RAILWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation {
            variableUpsert(input: {
              projectId: "${projectId}",
              environmentId: "${envId}",
              serviceId: "${bridgeServiceId}",
              name: "LMARENA_AUTH_TOKENS",
              value: "${newCookie}"
            })
          }
        `
      }),
    });
    const result = await resp.json();
    if (result.data && result.data.variableUpsert) {
      log('✅ Updated LMARENA_AUTH_TOKENS in bridge service');
      return true;
    } else {
      warn('Failed to update bridge var:', result.errors || result);
      return false;
    }
  } catch (e) {
    warn('Railway update error:', e.message);
    return false;
  }
}

async function refreshAndUpdateBridgeCookie(currentCookie) {
  const newCookie = await refreshSupabaseToken(currentCookie);
  if (newCookie !== currentCookie) {
    const updated = await updateBridgeServiceCookie(newCookie);
    if (updated) {
      log('Bridge service cookie updated. You may need to restart the lmarena-bridge service in Railway dashboard for it to take effect immediately.');
      // Optional: trigger restart
      // await restartBridgeService();
    }
    return newCookie;
  }
  return currentCookie;
}

// Optional: restart the bridge deployment (uncomment if desired, needs current deployment ID)
// async function restartBridgeService() { ... }

export { refreshSupabaseToken, refreshAndUpdateBridgeCookie, decodeCookie };