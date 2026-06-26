// BrowserAI regression provider certification matrix.
// Defines which providers are expected to pass which canonical task classes.

export const PROVIDER_TIERS = {
  managed_deepseek: {
    id: 'managed_deepseek',
    name: 'DeepSeek Managed (chat.deepseek.com)',
    baseUrl: 'https://chat.deepseek.com/api/v0',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    authType: 'managed_bearer',
    tier: 'primary',
    supportsTools: 'xml', // uses XML-in-fenced-block tool calls
    supportsStreaming: true,
    rateLimitRpm: 30,
  },
  openrouter_free: {
    id: 'openrouter_free',
    name: 'OpenRouter Free Tier',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'google/gemini-2.5-flash:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'meta-llama/llama-3.1-8b-instruct:free',
    ],
    authType: 'bearer',
    tier: 'free',
    supportsTools: 'native', // native OpenAI-compatible tool calls
    supportsStreaming: true,
    rateLimitRpm: 20,
  },
  gemini_official: {
    id: 'gemini_official',
    name: 'Google Gemini Official (AI Studio)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    authType: 'query_key',
    tier: 'primary',
    supportsTools: 'native',
    supportsStreaming: true,
    rateLimitRpm: 60,
  },
  zhipu_official: {
    id: 'zhipu_official',
    name: 'Zhipu AI (ChatGLM) Official',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-9b'],
    authType: 'bearer',
    tier: 'primary',
    supportsTools: 'native',
    supportsStreaming: true,
    rateLimitRpm: 100,
  },
  groq_official: {
    id: 'groq_official',
    name: 'Groq Official (Ultra-fast inference)',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.1-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    authType: 'bearer',
    tier: 'free',
    supportsTools: 'native',
    supportsStreaming: true,
    rateLimitRpm: 30,
  },
  anthropic_official: {
    // RPM-1: removed stray zhipu_official/groq_official fields that were copy-pasted inside this object
    id: 'anthropic_official',
    name: 'Anthropic Claude Official',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    authType: 'bearer',
    tier: 'premium',
    supportsTools: 'native',
    supportsStreaming: true,
    rateLimitRpm: 40,
  },
}

export const PROVIDER_TASK_COMPATIBILITY = {
  // Format: taskId -> { providerId: 'required' | 'recommended' | 'optional' | 'unsupported' }
  // If not specified, defaults to 'required' for all primary/premium, 'recommended' for free, 'optional' for local
  chat_greeting: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  web_news_query: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_create_file: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_create_js_module: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_mini_react_app: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required', // 3b models may struggle with complex React
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_browser_open: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required', // computer use requires larger model
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_read_then_edit: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_list_files: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_search_files: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_delete_file: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_create_node_project: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_esm_cjs_compat: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_git_init_commit: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_verify_after_edit: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_fake_success_trap: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_health_check: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_deploy_obligation: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_repo_analysis: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_empty_workspace: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_large_file_edit: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_shell_session_persist: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_web_search_and_save: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
  agent_secret_scan_after_edit: {
    managed_deepseek: 'required',
    openrouter_free: 'required',
    gemini_official: 'required',
    anthropic_official: 'required',
    zhipu_official: 'required',
    groq_official: 'required',
  },
}

export function getProviderCompatibility(taskId, providerId) {
  const taskCompat = PROVIDER_TASK_COMPATIBILITY[taskId]
  if (taskCompat && taskCompat[providerId]) return taskCompat[providerId]

  // Default rules based on tier
  const tier = PROVIDER_TIERS[providerId]?.tier
  if (tier === 'primary' || tier === 'premium') return 'required'
  if (tier === 'free') return 'recommended'
  if (tier === 'local') return 'optional'
  return 'optional'
}

export function listProviderIds() {
  return Object.keys(PROVIDER_TIERS)
}

export function listProviderTasks(providerId) {
  return Object.entries(PROVIDER_TASK_COMPATIBILITY)
    .filter(([taskId, compat]) => compat[providerId] && compat[providerId] !== 'unsupported')
    .map(([taskId]) => taskId)
}

export function getProviderTier(providerId) {
  return PROVIDER_TIERS[providerId]?.tier || 'unknown'
}

export function isProviderSupportedForTask(providerId, taskId) {
  return getProviderCompatibility(taskId, providerId) !== 'unsupported'
}

export default { PROVIDER_TIERS, PROVIDER_TASK_COMPATIBILITY, getProviderCompatibility }
