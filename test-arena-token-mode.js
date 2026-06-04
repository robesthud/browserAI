/**
 * Тест для pure token/cookie mode Arena.ai
 * Запуск: node --env-file=.env test-arena-token-mode.js
 */
import { isArenaEnabled, getArenaModels } from './server/arenaAdapter.js';

console.log('=== Arena.ai Pure Cookie/Token Mode Test ===');
console.log('isArenaEnabled():', isArenaEnabled());
console.log('AUTH_COOKIE present:', !!process.env.ARENA_AUTH_COOKIE);
console.log('REFRESH_TOKEN present:', !!process.env.ARENA_REFRESH_TOKEN);
console.log('ANON_KEY present:', !!process.env.ARENA_ANON_KEY);
console.log('EMAIL present (should be false):', !!process.env.ARENA_EMAIL);

const hasCookieOrToken = process.env.ARENA_AUTH_COOKIE || (process.env.ARENA_REFRESH_TOKEN && process.env.ARENA_ANON_KEY);
if (isArenaEnabled() && hasCookieOrToken && !process.env.ARENA_EMAIL) {
  console.log('✅ Pure token/cookie mode detected correctly — no auto-login will happen.');
  console.log('When deployed with real values + Chromium on Railway:');
  console.log('  - Uses the provided ARENA_AUTH_COOKIE directly');
  console.log('  - Auto-refreshes using embedded refresh_token (via Supabase)');
  console.log('  - Virtual "🏟 Arena.ai (server)" key appears automatically in UI');
  console.log('  - No manual config needed in the app');
} else {
  console.log('⚠️ Check your .env — ensure AUTH_COOKIE (or REFRESH+ANON) set, and NO EMAIL/PASSWORD.');
}

getArenaModels().then(m => {
  console.log('Hardcoded models available:', m.data.length);
});
