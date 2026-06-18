/**
 * mediaCapabilities.js
 *
 * Определяет, какие медиа-операции (генерация изображений/видео/TTS)
 * поддерживает ТЕКУЩИЙ выбранный провайдер/модель.
 *
 * Принцип: агент честно сообщает, если модель не умеет что-то делать,
 * вместо того чтобы молча переключаться на другой провайдер.
 *
 * Легко расширять: добавь новый case в detectImageCapability() / detectVideoCapability()
 * чтобы поддержать DALL-E, GLM-Image, Stable Diffusion, Veo, и т.д.
 */

// ── Генерация изображений ───────────────────────────────────────────────────

/**
 * @returns {capable, method, imageModel?, apiKey?, baseUrl?, hint?}
 *   capable=true  → модель может генерировать изображения
 *   capable=false → НЕ может; hint объясняет пользователю что делать
 */
export function detectImageCapability(provider = {}) {
  const model = String(provider?.model || '').toLowerCase()
  const baseUrl = String(provider?.baseUrl || '').toLowerCase()
  const apiKey = provider?.apiKey || ''

  // ── Gemini (Google) ──
  // Gemini поддерживает генерацию изображений через специальные model-варианты.
  // Текстовые варианты (gemini-3.1-flash-LITE) НЕ генерируют — нужен -image суффикс.
  if (baseUrl.includes('googleapis') || baseUrl.includes('generativelanguage') || /^gemini/.test(model)) {
    // Выбираем правильную image-модель (chat-модель подставляет image-вариант)
    const imageModel =
      /gemini-3\.1|gemini-3\b/.test(model) ? 'gemini-3.1-flash-image' :
      /gemini-2\.5/.test(model) ? 'gemini-2.5-flash-image' :
      'gemini-2.5-flash-image'
    return {
      capable: true,
      method: 'gemini',
      imageModel,
      apiKey,
      baseUrl: baseUrl.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com/v1beta',
    }
  }

  // ── OpenAI DALL-E (будущее) ──
  if (/dall-e-?[23]/.test(model) && baseUrl.includes('openai')) {
    return {
      capable: true,
      method: 'openai-images',
      imageModel: model,
      apiKey,
      baseUrl,
    }
  }

  // ── Zhipu GLM-Image / CogView (будущее) ──
  if (/glm-image|cogview/.test(model) || (baseUrl.includes('bigmodel') && /image|cogview/.test(model))) {
    return {
      capable: true,
      method: 'glm-image',
      imageModel: /cogview/.test(model) ? model : 'cogview-4',
      apiKey,
      baseUrl,
    }
  }

  // ── Stable Diffusion / FLUX через OpenAI-compatible провайдеров (будущее) ──
  if (/flux|stable.diffusion|sdxl|seedream|imagen/.test(model)) {
    return {
      capable: true,
      method: 'openai-images', // большинство SD-провайдеров (Together, Fal, Replicate) используют OpenAI-совместимый /images/generations
      imageModel: model,
      apiKey,
      baseUrl,
    }
  }

  // ── Не поддерживает ──
  return {
    capable: false,
    hint: `Эта модель (${model || 'неизвестно'}) не поддерживает генерацию изображений. ` +
      `Выберите модель с поддержкой генерации: Gemini (gemini-2.5-flash / gemini-3.1-flash) ` +
      `или другую image-модель (DALL-E, GLM-Image, FLUX).`,
  }
}

// ── Генерация видео ─────────────────────────────────────────────────────────

export function detectVideoCapability(provider = {}) {
  const model = String(provider?.model || '').toLowerCase()
  const baseUrl = String(provider?.baseUrl || '').toLowerCase()
  const apiKey = provider?.apiKey || ''

  // ── Google Veo ──
  if (baseUrl.includes('googleapis') || /veo/.test(model)) {
    return {
      capable: true,
      method: 'veo',
      videoModel: /veo-3/.test(model) ? 'veo-3.0-generate' : 'veo-2.0-generate',
      apiKey,
      baseUrl: baseUrl.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com/v1beta',
    }
  }

  // ── Не поддерживает ──
  return {
    capable: false,
    hint: `Эта модель (${model || 'неизвестно'}) не поддерживает генерацию видео. ` +
      `Для генерации видео выберите модель Google Veo (veo-2.0 / veo-3.0).`,
  }
}

// ── Редактирование изображений ──────────────────────────────────────────────

/**
 * Редактирование требует ту же модель, что и генерация (vision + image gen).
 */
export function detectImageEditCapability(provider = {}) {
  const cap = detectImageCapability(provider)
  if (!cap.capable) return cap
  return { ...cap, method: 'gemini-edit' }
}

export default {
  detectImageCapability,
  detectVideoCapability,
  detectImageEditCapability,
}
