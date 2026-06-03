# BrowserAI Cloudflare Proxy

Решает проблему гео-блокировки: DeepSeek и другие провайдеры блокируют IP датацентров (Railway, Heroku и т.д.), но пропускают Cloudflare Workers.

## Деплой

1. Установите Wrangler: `npm install -g wrangler`
2. Авторизуйтесь: `npx wrangler login`
3. Задеплойте: `cd cf-proxy && npx wrangler deploy`
4. Установите секрет: `npx wrangler secret put PROXY_SECRET` (введите любой пароль)
5. Скопируйте URL воркера (например `https://browserai-proxy.your.workers.dev`)

## Настройка BrowserAI

Добавьте переменные в Railway:
- `CF_PROXY_URL` = `https://browserai-proxy.your.workers.dev`
- `CF_PROXY_SECRET` = тот же секрет что в шаге 4

Сервер автоматически будет проксировать сессионные запросы через Cloudflare.

## Бесплатные лимиты Cloudflare Workers

- 100,000 запросов/день
- 10ms CPU time на запрос (streaming не считается)
- Этого хватит на ~1000-2000 сообщений/день
