/**
 * Авторежим выбора модели.
 * Анализирует текст запроса и подбирает наиболее подходящую модель
 * из доступного списка.
 */

// Категории задач и ключевые слова
const TASK_PATTERNS = [
  {
    type: 'image',
    keywords: [
      'нарисуй', 'нарисовать', 'рисунок', 'изображение', 'картинку', 'картина',
      'сгенерируй изображение', 'сделай фото', 'draw', 'image', 'picture', 'generate image',
      'illustration', 'иллюстрацию', 'арт', 'art', 'создай картинку',
    ],
    // модели хорошие для генерации изображений
    preferKeywords: ['dall-e', 'dall.e', 'flux', 'imagen', 'stable', 'midjourney', 'sdxl'],
  },
  {
    type: 'code',
    keywords: [
      'напиши код', 'напиши функцию', 'напиши скрипт', 'напиши программу',
      'исправь код', 'отладь', 'дебаг', 'баг', 'ошибка в коде',
      'написать код', 'python', 'javascript', 'typescript', 'react', 'vue',
      'программу', 'скрипт', 'функцию', 'класс', 'алгоритм',
      'write code', 'fix code', 'debug', 'function', 'script', 'program',
      'реализуй', 'implement',
    ],
    // модели хорошие для кода
    preferKeywords: ['claude', 'sonnet', 'opus', 'gpt-4', 'gpt4', 'deepseek', 'coder', 'qwen', 'codestral'],
  },
  {
    type: 'reasoning',
    keywords: [
      'реши задачу', 'математика', 'вычисли', 'докажи', 'логика',
      'объясни почему', 'проанализируй', 'сравни', 'оцени',
      'math', 'solve', 'calculate', 'prove', 'reason', 'analyze',
      'анализ', 'рассуждение',
    ],
    preferKeywords: ['o1', 'o3', 'reasoning', 'think', 'r1', 'deepseek-r', 'claude', 'opus'],
  },
  {
    type: 'creative',
    keywords: [
      'напиши рассказ', 'напиши стихотворение', 'напиши историю',
      'придумай', 'сочини', 'напиши песню', 'напиши сценарий',
      'write story', 'write poem', 'creative writing', 'fiction',
      'рассказ', 'стих', 'поэзия', 'история', 'сказка',
    ],
    preferKeywords: ['claude', 'gpt-4', 'gemini', 'llama', 'mistral'],
  },
  {
    type: 'fast',
    keywords: [
      'быстро ответь', 'коротко', 'кратко', 'в двух словах',
      'quick', 'briefly', 'short answer', 'tldr',
    ],
    preferKeywords: ['mini', 'haiku', 'flash', 'lite', 'turbo', 'small', 'instant'],
  },
]

/**
 * Определяет тип задачи по тексту запроса
 */
function classifyTask(text) {
  const lower = text.toLowerCase()
  for (const pattern of TASK_PATTERNS) {
    for (const keyword of pattern.keywords) {
      if (lower.includes(keyword)) {
        return pattern
      }
    }
  }
  return null
}

/**
 * Оценивает насколько модель подходит для данного типа задачи
 * Возвращает число — чем больше тем лучше
 */
function scoreModelForTask(modelId, task) {
  const id = modelId.toLowerCase()
  let score = 0

  if (!task) return score

  // Проверяем prefKeywords из паттерна
  for (const kw of task.preferKeywords) {
    if (id.includes(kw)) score += 10
  }

  // Штрафуем модели которые явно не для этого типа
  if (task.type === 'image') {
    // для изображений НЕ нужны чат-модели
    if (id.includes('claude') || id.includes('gpt') || id.includes('gemini')) score -= 5
  }

  if (task.type === 'code' || task.type === 'reasoning') {
    // для кода и рассуждений mini/flash/haiku хуже
    if (id.includes('mini') || id.includes('haiku') || id.includes('flash') || id.includes('lite')) score -= 3
  }

  return score
}

/**
 * Основная функция — выбирает лучшую модель для запроса
 * @param {string} text — текст запроса
 * @param {string[]} models — список доступных моделей
 * @param {string} currentModel — текущая выбранная модель
 * @returns {{ model: string, reason: string, changed: boolean }}
 */
export function pickBestModel(text, models, currentModel) {
  if (!models || models.length === 0) {
    return { model: currentModel, reason: '', changed: false }
  }

  if (models.length === 1) {
    return { model: models[0], reason: '', changed: false }
  }

  const task = classifyTask(text)

  if (!task) {
    // Нет явной задачи — оставляем текущую модель
    return { model: currentModel || models[0], reason: '', changed: false }
  }

  // Оцениваем все модели
  const scored = models.map((m) => ({
    model: m,
    score: scoreModelForTask(m, task),
  }))

  // Сортируем по score
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]

  // Переключаем только если нашли модель с ненулевым преимуществом
  if (best.score > 0 && best.model !== currentModel) {
    const reasonMap = {
      image: '🎨 автовыбор для генерации изображений',
      code: '💻 автовыбор для кода',
      reasoning: '🧠 автовыбор для сложных задач',
      creative: '✍️ автовыбор для творческих задач',
      fast: '⚡ автовыбор быстрой модели',
    }
    return {
      model: best.model,
      reason: reasonMap[task.type] || 'автовыбор',
      changed: true,
    }
  }

  return { model: currentModel || models[0], reason: '', changed: false }
}

/**
 * Иконка для типа задачи
 */
export function getTaskIcon(text) {
  const task = classifyTask(text)
  if (!task) return null
  const icons = {
    image: '🎨',
    code: '💻',
    reasoning: '🧠',
    creative: '✍️',
    fast: '⚡',
  }
  return icons[task.type] || null
}
