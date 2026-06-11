import { describe, expect, it } from 'vitest'
import { routeUserMessage } from '../server/smartRouter.js'

describe('server smart router', () => {
  it('routes simple prompts to chat', () => {
    expect(routeUserMessage('Привет').mode).toBe('chat')
    expect(routeUserMessage('Что такое фотосинтез?').mode).toBe('chat')
    expect(routeUserMessage('Напиши короткое письмо клиенту').mode).toBe('chat')
  })

  it('routes current-info prompts to web', () => {
    expect(routeUserMessage('Какая погода в Волгограде?').mode).toBe('web')
    expect(routeUserMessage('Курс доллара сегодня').mode).toBe('web')
    expect(routeUserMessage('latest news about AI').mode).toBe('web')
  })

  it('routes tool/code/ops prompts to agent', () => {
    expect(routeUserMessage('Проверь логи Timeweb').mode).toBe('agent')
    expect(routeUserMessage('Исправь баг в Composer.jsx').mode).toBe('agent')
    expect(routeUserMessage('Создай файл hello.txt').mode).toBe('agent')
    expect(routeUserMessage('Запусти docker compose ps').mode).toBe('agent')
  })
})
