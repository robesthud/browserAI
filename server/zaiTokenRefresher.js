/**
 * zaiTokenRefresher.js — Z.ai (chat.z.ai) session manager
 *
 * Mirrors deepseekTokenRefresher.js pattern:
 *   1. Stores cookies in /data/zai_session.json (survives restarts)
 *   2. Heartbeat every 10 min to keep session alive
 *   3. Caches available models (refreshed hourly)
 *   4. Telegram notifications on session issues
 *
 * Z.ai uses OAuth (Google/GitHub) → session cookies.
 * User provides cookies from browser DevTools → Application → Cookies.
 */

import fs from "node:fs";
import path from "node:path";

const STATE_FILE = process.env.ZAI_STATE_FILE || "/data/zai_session.json";
const HEARTBEAT_MS = Number(process.env.ZAI_HEARTBEAT_MS) || 10 * 60 * 1000;
const MODELS_MS = Number(process.env.ZAI_MODELS_REFRESH_MS) || 60 * 60 * 1000;
const ZAI_BASE = "https://chat.z.ai";
const TG_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_ADMIN_CHAT_ID || "";

let state = {
  cookies: {},          // { key: value } from browser
  cookieHeader: "",     // Raw Cookie header string
  alive: false,
  lastSeenAt: 0,
  lastRefreshAt: 0,
  lastError: "",
  user: null,
};

let modelsCache = { list: [], fetchedAt: 0, error: "" };
let heartbeatTimer = null;
let modelsTimer = null;

function log(...a) { console.log("[zai-refresh]", ...a); }
function warn(...a) { console.warn("[zai-refresh]", ...a); }

// ── Telegram notify ──
async function notifyTg(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: "[Z.ai] " + text, parse_mode: "HTML" }),
    });
  } catch {}
}

// ── Persistence ──
function loadFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const saved = JSON.parse(raw);
      if (saved.cookies) {
        state.cookies = saved.cookies;
        state.cookieHeader = buildCookieHeader(saved.cookies);
        state.lastRefreshAt = saved.lastRefreshAt || 0;
        state.user = saved.user || null;
        log("Loaded persisted session, cookies=" + Object.keys(state.cookies).length);
        return true;
      }
    }
  } catch (e) { warn("Failed to load session:", e.message); }
  return false;
}

function saveToDisk() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      cookies: state.cookies,
      lastRefreshAt: state.lastRefreshAt,
      user: state.user,
      savedAt: Date.now(),
    }, null, 2));
  } catch (e) { warn("Failed to save session:", e.message); }
}

function buildCookieHeader(cookies) {
  return Object.entries(cookies || {})
    .map(function(e) { return e[0] + "=" + e[1]; })
    .join("; ");
}

// ── API calls ──
async function apiCall(method, urlPath, opts) {
  opts = opts || {};
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "Origin": ZAI_BASE,
    "Referer": ZAI_BASE + "/",
    ...(opts.headers || {}),
  };
  if (state.cookieHeader) headers["Cookie"] = state.cookieHeader;

  const resp = await fetch(ZAI_BASE + urlPath, {
    method: method,
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
  return resp;
}

// ── Heartbeat ──
async function heartbeat(opts) {
  opts = opts || {};
  try {
    const resp = await apiCall("GET", "/api/user/info");
    if (resp.status === 200) {
      const data = await resp.json();
      state.alive = true;
      state.lastSeenAt = Date.now();
      state.lastError = "";
      if (data.data || data.user) {
        state.user = data.data || data.user;
      }
      if (!opts.silent) log("Heartbeat OK, user:", state.user?.nickname || state.user?.email || "?");
      return true;
    }
    if (resp.status === 401 || resp.status === 403) {
      state.alive = false;
      state.lastError = "Session expired (HTTP " + resp.status + ")";
      warn(state.lastError);
      await notifyTg("Z.ai session EXPIRED — re-supply cookies");
      return false;
    }
    state.lastError = "Unexpected status " + resp.status;
    warn(state.lastError);
    return false;
  } catch (e) {
    state.lastError = e.message;
    warn("Heartbeat failed:", e.message);
    return false;
  }
}

// ── Fetch models ──
async function fetchModels() {
  try {
    const resp = await apiCall("GET", "/api/models");
    if (resp.status === 200) {
      const data = await resp.json();
      const list = (data.data || data.models || []).map(function(m) {
        return { id: m.id || m.name || m.model, name: m.displayName || m.name || m.id, provider: "z.ai" };
      });
      modelsCache = { list: list, fetchedAt: Date.now(), error: "" };
      log("Models fetched:", list.length);
    }
  } catch (e) {
    modelsCache.error = e.message;
    warn("Models fetch failed:", e.message);
  }
}

// ── Public API ──
export function getSessionState() {
  return {
    alive: state.alive,
    user: state.user,
    cookieCount: Object.keys(state.cookies).length,
    lastSeenAt: state.lastSeenAt,
    lastError: state.lastError,
  };
}

export function getCookieHeader() {
  return state.cookieHeader || "";
}

export function getActiveBearer() {
  // Z.ai uses cookies, not Bearer tokens
  return "";
}

export function getCachedModels() {
  return modelsCache.list || [];
}

export function isSessionValid() {
  return state.alive && state.cookieHeader.length > 0;
}

export async function refreshNow(opts) {
  opts = opts || {};
  state.lastRefreshAt = Date.now();
  const ok = await heartbeat({ silent: opts.silent });
  if (ok && (Date.now() - modelsCache.fetchedAt > MODELS_MS)) {
    await fetchModels();
  }
  return state.alive;
}

export async function setSession(opts) {
  opts = opts || {};
  if (opts.cookies) {
    if (typeof opts.cookies === "string") {
      // Parse "key1=val1; key2=val2" format
      state.cookies = {};
      opts.cookies.split(";").forEach(function(p) {
        var parts = p.trim().split("=");
        if (parts.length >= 2) state.cookies[parts[0].trim()] = parts.slice(1).join("=").trim();
      });
    } else {
      state.cookies = opts.cookies;
    }
    state.cookieHeader = buildCookieHeader(state.cookies);
  }
  if (opts.cookieHeader) {
    state.cookieHeader = opts.cookieHeader;
  }
  saveToDisk();
  log("Session updated, cookies=" + Object.keys(state.cookies).length);
  await refreshNow({ silent: false });
  return state.alive;
}

// ── Bootstrap ──
export function bootstrap() {
  log("Bootstrap starting...");
  const loaded = loadFromDisk();

  if (loaded && state.cookieHeader) {
    setTimeout(async function() {
      const ok = await heartbeat({ silent: true });
      if (ok) {
        log("Bootstrap complete. cookies=" + Object.keys(state.cookies).length);
        await fetchModels();
      } else {
        log("Bootstrap: session invalid, waiting for admin to set cookies");
      }
    }, 5000);
  } else {
    log("No saved session. Set cookies via API or env var ZAI_COOKIES.");
  }

  // Check env var for bootstrap
  const envCookies = process.env.ZAI_COOKIES || "";
  if (envCookies && !loaded) {
    setTimeout(function() {
      setSession({ cookies: envCookies, source: "env" });
    }, 3000);
  }

  heartbeatTimer = setInterval(function() {
    heartbeat({ silent: true }).catch(function() {});
  }, HEARTBEAT_MS);
  heartbeatTimer.unref && heartbeatTimer.unref();

  modelsTimer = setInterval(function() {
    fetchModels().catch(function() {});
  }, MODELS_MS);
  modelsTimer.unref && modelsTimer.unref();

  log("Bootstrap done. Heartbeat=" + (HEARTBEAT_MS / 60000) + "min, Models=" + (MODELS_MS / 60000) + "min");
}

export function stopZaiTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (modelsTimer) clearInterval(modelsTimer);
  heartbeatTimer = null;
  modelsTimer = null;
}
