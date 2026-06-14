// Регрессионный тест классификатора задач (lite vs full agent runs).
// Появился после оптимизации авторежима: «привет» обходился в ~47k токенов
// контекста, потому что классифицировался как medium и тянул полный
// system prompt + repo map + memory preload.
import { describe, it, expect } from 'vitest'
import { classifyAgentTask } from '../server/agentCore.js'
import { buildClineSystemPrompt } from '../server/clinePrompt.js'

const CASES = [
  // Small talk / простые вопросы → low (lite prompt, без repo map)
  ['Привет!', 'low'],
  ['Привет! Скажи коротко, какая модель сейчас отвечает?', 'low'],
  ['Кто ты и что ты умеешь?', 'low'],
  ['Спасибо, отлично!', 'low'],
  ['Сколько будет 17*23? Ответь только числом.', 'low'],
  ['Который час?', 'low'],
  ['Как дела?', 'low'],
  ['Объясни, чем REST отличается от GraphQL', 'low'],
  ['Расскажи анекдот', 'low'],
  // Реальная работа → medium/high (полный prompt)
  ['Склонируй https://github.com/robesthud/agent_mod и найди баги', 'high'],
  ['Задеплой проект на сервер', 'high'],
  ['Исправь ошибку в server/index.js', 'high'],
  ['Проанализируй структуру проекта', 'high'],
  ['Напиши скрипт для бэкапа базы', 'high'],
  ['Проверь логи на сервере', 'high'],
  ['Найди в интернете актуальную документацию по Vite 8', 'medium'],
  ['Создай файл hello.txt с текстом привет мир', 'medium'],
  ['Скачай репозиторий с гитхаба', 'medium'],
  ['Скачай файлы с github robesthud/browserai', 'medium'],
  ['Скачай файлы с GitHub robesthud/browserAI', 'medium'],
  // Вежливое обращение + действие = всё равно работа, не small talk
  ['Привет! Создай пожалуйста новую папку для проекта', 'medium'],
]

describe('classifyAgentTask: lite vs full routing', () => {
  for (const [text, want] of CASES) {
    it(`"${text.slice(0, 50)}" → ${want}`, () => {
      expect(classifyAgentTask(text).complexity).toBe(want)
    })
  }
})

describe('lite system prompt', () => {
  it('is at least 4x smaller than the full prompt', () => {
    const full = buildClineSystemPrompt({ cwd: '/workspace' })
    const lite = buildClineSystemPrompt({ cwd: '/workspace', lite: true })
    expect(lite.length).toBeLessThan(full.length / 4)
    // Sanity: lite prompt still teaches tool-use formatting
    expect(lite).toContain('Available Tools')
  })
})
