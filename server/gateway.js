import { isSessionValid as isDeepSeekValid } from './deepseekTokenRefresher.js'

export const GATEWAY_BASE_URL = 'https://browserai.local/free-gateway'
export const GATEWAY_API_KEY = '__gateway__'

export const GATEWAY_MODELS = [
  { id: 'deepseek_chat', provider: 'deepseek', label: 'DeepSeek Chat', capabilities: ['text', 'chat'] },
  { id: 'deepseek_reasoner', provider: 'deepseek', label: 'DeepSeek Reasoner', capabilities: ['text', 'reasoning', 'code'] },
  { id: 'gemini-2.5-pro', provider: 'gemini', label: 'Gemini 2.5 Pro', capabilities: ['text', 'imageInput', 'imageOutput', 'reasoning'] },
  { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', capabilities: ['text', 'imageInput', 'imageOutput', 'fast'] },
  { id: 'gemini-2.0-flash', provider: 'gemini', label: 'Gemini 2.0 Flash', capabilities: ['text', 'imageInput', 'imageOutput', 'fast'] },
]

export function isGatewayUrl(baseUrl = '') {
  return String(baseUrl || '').replace(/\/$/, '') === GATEWAY_BASE_URL
}

export function getGatewayModels() {
  return GATEWAY_MODELS.map((m) => m.id)
}

export function getGatewayStatus() {
  return {
    enabled: true,
    deepseek: { alive: Boolean(isDeepSeekValid?.()), models: ['deepseek_chat', 'deepseek_reasoner'] },
    gemini: { alive: true, models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
    models: GATEWAY_MODELS,
  }
}

export function resolveGatewayModel(model = '') {
  const id = String(model || '').trim()
  const found = GATEWAY_MODELS.find((m) => m.id === id) || GATEWAY_MODELS[0]
  if (found.provider === 'deepseek') {
    return {
      provider: 'deepseek',
      baseUrl: 'https://chat.deepseek.com/api/v0',
      apiKey: '__managed__',
      authType: 'bearer',
      model: found.id,
      extraHeaders: { Referer: 'https://chat.deepseek.com/', Origin: 'https://chat.deepseek.com' },
    }
  }
  return {
    provider: 'gemini',
    baseUrl: 'http://host.docker.internal:8080/v1',
    apiKey: 'not-needed',
    authType: 'bearer',
    model: found.id,
    extraHeaders: {},
  }
}
