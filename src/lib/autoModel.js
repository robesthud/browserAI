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
      'нарисуй', 'нарисовать', 'рисунок', 'изображение', 'картинку', 'картину',
      'сгенерируй изображение', 'создай изображение', 'сделай фото',
      'draw', 'image', 'picture', 'generate image', 'create image',
      'illustration', 'иллюстрацию', 'иллюстрация', 'арт', 'art', 'создай картинку',
      'нарисуй мне', 'визуализируй', 'сгенерируй картинку', 'создай картинку', 'картинка',
      'фото', 'изображения', 'генерация изображения',
    ],
    preferKeywords: ['gemini', 'imagen', 'dall-e', 'dall.e', 'flux', 'stable', 'midjourney', 'sdxl', 'kandinsky'],
    label: 'изображения',
  },
  {
    type: 'code',
    keywords: [
      'напиши код', 'напиши функцию', 'напиши скрипт', 'напиши программу',
      'исправь код', 'отладь', 'дебаг', 'баг', 'ошибка в коде',
      'написать код', 'написать программу', 'написать функцию',
      'python', 'javascript', 'typescript', 'react', 'vue', 'angular',
      'программу', 'скрипт', 'функцию', 'класс', 'алгоритм', 'компонент',
      'write code', 'fix code', 'debug', 'function', 'script', 'program',
      'реализуй', 'implement', 'написать api', 'сделай api',
      'напиши тест', 'unit test', 'рефакторинг', 'refactor',
      'sql', 'запрос к бд', 'database',
    ],
    preferKeywords: ['claude', 'sonnet', 'opus', 'gpt-4', 'gpt4', 'deepseek', 'coder', 'qwen', 'codestral', 'starcoder'],
    label: 'программирование',
  },
  {
    type: 'reasoning',
    keywords: [
      'реши задачу', 'математика', 'вычисли', 'докажи', 'логика',
      'объясни почему', 'проанализируй', 'сравни', 'оцени',
      'math', 'solve', 'calculate', 'prove', 'reason', 'analyze',
      'анализ', 'рассуждение', 'выведи', 'докажи теорему',
      'найди решение', 'оптимизируй', 'задача', 'уравнение',
      'объясни механизм', 'почему это работает',
    ],
    preferKeywords: ['o1', 'o3', 'reasoning', 'think', 'r1', 'deepseek-r', 'claude', 'opus', 'gemini'],
    label: 'сложные задачи',
  },
  {
    type: 'creative',
    keywords: [
      'напиши рассказ', 'напиши стихотворение', 'напиши стих', 'напиши историю',
      'придумай', 'сочини', 'напиши песню', 'напиши сценарий', 'напиши пост',
      'write story', 'write poem', 'creative writing', 'fiction',
      'рассказ', 'стих', 'поэзия', 'история', 'сказка', 'роман',
      'придумай имя', 'придумай слоган', 'текст для', 'напиши описание',
      'маркетинговый текст', 'рекламный текст', 'продающий текст',
    ],
    preferKeywords: ['claude', 'gpt-4', 'gemini', 'llama', 'mistral'],
    label: 'творчество',
  },
  {
    type: 'translation',
    keywords: [
      'переведи', 'перевести', 'переведи на', 'translate', 'translation',
      'перевод с', 'перевод на', 'как сказать по', 'как будет по-',
    ],
    preferKeywords: ['gpt-4', 'gemini', 'claude', 'deepl', 'nllb'],
    label: 'перевод',
  },
  {
    type: 'fast',
    keywords: [
      'быстро ответь', 'коротко', 'кратко', 'в двух словах',
      'quick', 'briefly', 'short answer', 'tldr', 'tl;dr',
      'одним словом', 'одной строкой',
    ],
    preferKeywords: ['mini', 'haiku', 'flash', 'lite', 'turbo', 'small', 'instant', 'nano'],
    label: 'быстрый ответ',
  },
]

/**
 * Определяет тип задачи по тексту запроса
 * Возвращает найденный паттерн или null
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

  // Проверяем preferKeywords из паттерна
  for (const kw of task.preferKeywords) {
    if (id.includes(kw)) score += 10
  }

  // Штрафуем модели которые явно не для этого типа
  if (task.type === 'image') {
    // Для изображений предпочитаем модели/провайдеры, у которых есть image-generation route.
    // Gemini Web умеет генерировать картинки через web UI, поэтому НЕ штрафуем gemini.
    if (id.includes('deepseek') || id.includes('reasoner') || id.includes('coder')) score -= 6
    if (id.includes('claude') || id.includes('gpt')) score -= 2
  }

  if (task.type === 'code' || task.type === 'reasoning') {
    // для кода и рассуждений mini/flash/haiku хуже
    if (id.includes('mini') || id.includes('haiku') || id.includes('flash') || id.includes('lite') || id.includes('nano')) score -= 3
  }

  if (task.type === 'fast') {
    // для быстрых ответов большие модели менее приоритетны
    if (id.includes('opus') || id.includes('large') || id.includes('ultra')) score -= 2
  }

  return score
}

/**
 * Основная функция — выбирает лучшую модель для запроса
 * @param {string} text — текст запроса
 * @param {string[]} models — список доступных моделей
 * @param {string} currentModel — текущая выбранная модель
 * @returns {{ model: string, reason: string, taskType: string|null, changed: boolean }}
 */
export function pickBestModel(text, models, currentModel) {
  if (!models || models.length === 0) {
    return { model: currentModel, reason: '', taskType: null, changed: false }
  }

  if (models.length === 1) {
    return { model: models[0], reason: '', taskType: null, changed: false }
  }

  const task = classifyTask(text)

  if (!task) {
    // Нет явной задачи — оставляем текущую модель
    return { model: currentModel || models[0], reason: '', taskType: null, changed: false }
  }

  // Оцениваем все модели
  const scored = models.map((m) => ({
    model: m,
    score: scoreModelForTask(m, task),
  }))

  // Сортируем по score
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]

  // Переключаем только если нашли модель с реальным преимуществом
  if (best.score > 0 && best.model !== currentModel) {
    const icons = {
      image: '🎨',
      code: '💻',
      reasoning: '🧠',
      creative: '✍️',
      translation: '🌐',
      fast: '⚡',
    }
    const icon = icons[task.type] || '✨'
    return {
      model: best.model,
      reason: `${task.label}`,
      taskType: task.type,
      icon,
      changed: true,
    }
  }

  return { model: currentModel || models[0], reason: '', taskType: null, changed: false }
}

/**
 * Возвращает иконку задачи по тексту запроса
 */
export function getTaskIcon(text) {
  const task = classifyTask(text)
  if (!task) return null
  const icons = {
    image: '🎨',
    code: '💻',
    reasoning: '🧠',
    creative: '✍️',
    translation: '🌐',
    fast: '⚡',
  }
  return icons[task.type] || null
}

/**
 * Возвращает тип задачи по тексту
 */
export function getTaskType(text) {
  const task = classifyTask(text)
  return task?.type || null
}
