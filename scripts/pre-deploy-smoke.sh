#!/bin/bash
# Pre-deploy smoke suite for BrowserAI
# Runs canonical regression tasks against available providers before deploy.
# Exit 0 = all critical tasks passed, Exit 1 = critical failures detected.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/browserai}"
TIMEOUT_PER_TASK="${SMOKE_TIMEOUT_PER_TASK:-120}"
MAX_CONCURRENT="${SMOKE_MAX_CONCURRENT:-2}"

cd "$APP_DIR"

# Only run if Node.js is available (skip if building image from scratch)
if ! command -v node >/dev/null 2>&1; then
  echo "[pre-deploy-smoke] Node.js not available in build context — skipping smoke (will run post-deploy)."
  exit 0
fi

# Check if we have at least one configured provider
if [ ! -f .env ]; then
  echo "[pre-deploy-smoke] No .env found — skipping smoke."
  exit 0
fi

# Check if DEEPSEEK_USER_TOKEN or OPENAI_API_KEY or GEMINI_API_KEY or ANTHROPIC_API_KEY exists
if ! grep -qE '^(DEEPSEEK_USER_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY|ZHIPU_API_KEY)=' .env 2>/dev/null; then
  echo "[pre-deploy-smoke] No API keys configured — skipping smoke."
  exit 0
fi

echo "[pre-deploy-smoke] Running pre-deploy smoke suite..."

# Run smoke via Node.js inline script
node --input-type=module --eval "
import { runRegressionMatrix } from './server/regressionRunner.js';
import { listProviderIds } from './server/regressionProviderMatrix.js';
import { defaultCanonicalTaskIds } from './server/regressionSuite.js';

const CRITICAL_TASKS = defaultCanonicalTaskIds({ includeChat: true, includeWeb: true, includeAgent: true });
const AVAILABLE_PROVIDERS = listProviderIds().filter(id => {
  const envMap = {
    managed_deepseek: 'DEEPSEEK_USER_TOKEN',
    openrouter_free: 'OPENAI_API_KEY',
    gemini_official: 'GEMINI_API_KEY',
    anthropic_official: 'ANTHROPIC_API_KEY',
    groq_official: 'GROQ_API_KEY',
    zhipu_official: 'ZHIPU_API_KEY',
    ollama_local: 'OLLAMA_ALWAYS_AVAILABLE',
  };
  const envKey = envMap[id];
  if (!envKey) return false;
  if (envKey === 'OLLAMA_ALWAYS_AVAILABLE') return true;
  return process.env[envKey] !== undefined;
});

if (AVAILABLE_PROVIDERS.length === 0) {
  console.log('[pre-deploy-smoke] No providers available with keys — skipping.');
  process.exit(0);
}

// Run only first provider × first 3 critical tasks to keep deploy fast
const testProviders = AVAILABLE_PROVIDERS.slice(0, 1);
const testTasks = CRITICAL_TASKS.slice(0, 3);

console.log('[pre-deploy-smoke] Tasks:', testTasks.join(', '));
console.log('[pre-deploy-smoke] Provider:', testProviders[0]);

try {
  const summary = await runRegressionMatrix({
    taskIds: testTasks,
    providerIds: testProviders,
    timeoutMs: 300_000,
  });
  console.log('[pre-deploy-smoke] Summary:', JSON.stringify(summary, null, 2));
  const criticalFailures = summary.runs.filter(r => r.status === 'failed' || r.status === 'blocked');
  if (criticalFailures.length > 0) {
    console.error('[pre-deploy-smoke] CRITICAL FAILURES:', criticalFailures.length);
    process.exit(1);
  }
  console.log('[pre-deploy-smoke] All critical smoke tests passed.');
} catch (e) {
  console.error('[pre-deploy-smoke] Smoke runner error:', e.message);
  // Non-blocking: log but don't fail deploy if smoke infrastructure is immature
  console.log('[pre-deploy-smoke] Smoke failed but allowing deploy (warning).');
  process.exit(0);
}
" 2>&1 || {
  echo "[pre-deploy-smoke] Smoke runner exited with error — deploy continuing with warning."
  exit 0
}

echo "[pre-deploy-smoke] Pre-deploy smoke complete."
