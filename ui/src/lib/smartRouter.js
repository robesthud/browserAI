/**
 * Lightweight client-side router for BrowserAI.
 *
 * Goal: do NOT send every user turn through the expensive full agent loop.
 * The router is deliberately model-agnostic:
 *   - chat: plain /api/chat, no tools, cheapest
 *   - web:  plain /api/chat + server-built web context (settings.useWebAI=true)
 *   - agent: full /api/agent/chat with tools/workspace/bash/deploy
 *
 * Agent patterns are broad — anything that implies building, fixing, deploying,
 * reading/writing files, or working with code should go to the agent.
 */

function textFromAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  return attachments.map((a) => `${a?.name || ''} ${a?.type || ''} ${a?.path || ''}`).join(' ')
}

export function routeUserMessage(text = '', attachments = [], { forceAgent = false } = {}) {
  const raw = String(text || '').trim()
  const att = textFromAttachments(attachments).toLowerCase()

  if (forceAgent) {
    return {
      mode: 'agent',
      reason: 'Агент включён вручную',
      icon: '🤖',
    }
  }

  if (!raw && attachments.length) {
    return { mode: 'chat', reason: 'Вложения без команды', icon: '💬' }
  }

  // ── Agent patterns: anything that needs files, tools, code, or deployment ──
  const agentPatterns = [
    // DevOps / infrastructure / servers
    /\b(ssh|docker|nginx|apache|systemctl|journalctl|timeweb|vps|vds|deploy|деплой|сервер|сервере|логи|логах|github|git|ci\/cd|kubernetes|k8s|docker-compose|compose|terraform|ansible|cloudflare|dns)\b/i,

    // Verbs: create / build / modify
    /(создай|создайте|создать|сделай|сделайте|сделать|напиши|напишите|написать|построй|построить|собери|собрать|реализуй|реализовать|добавь|добавьте|добавить|перепиши|перепишите|измени|измените|изменить|обнови|обновите|обновить|удали|удалите|удалить|переименуй|переименуйте|протестируй|протестировать|проверь код|найди в файлах|прочитай файл|создай файл|удали файл|сгенерируй|сгенерировать|генерируй)/i,

    // Verbs: connect / configure / run / execute
    /(зайди|зайдите|подключись|подключиться|настрой|настройте|настроить|установи|установите|установить|запусти|запустите|запустить|выполни|выполните|выполнить команд|bash|консоль|терминал|shell|команду)/i,

    // Verbs: fix / debug / optimize
    /(исправ|исправь|исправьте|почини|почините|починить|дебаг|отладк|debug|фикс|фиксан|проблем|не работает|ломаетс|ошибк|баг|баги|багом|поломк|упал|краш|падает|зависает|тормозит|оптимизируй|оптимизировать|улучш|рефактор|рефакторинг|почему не работает|почему не)/i,

    // Verbs: data / integration / automation
    /(парсинг|парсить|скрап|скрейп|экспорт|импорт|конвертируй|конвертировать|интеграц|автоматизируй|автоматизировать|скрипт|cron|планировщик|пайплайн|pipeline|отправь|отправить|email|почта|уведомл|push|webhook|телеграм|telegram)/i,

    // Files / projects / workspace
    /(workspace|репозитор|репозиторий|проект|код|скрипт|файл|файлы|папк|папке|папку|readme|package\.json|compose|dockerfile|gitignore|env|\.env)/i,

    // Apps / bots / services / APIs
    /(бот|боты|боту|telegram|телеграм|telegram bot|weather bot|погод|сайт|вебсайт|страница|приложени|app|сервис|api|эндпоинт|endpoint|веб|web|лендинг|магазин|e-commerce|плагин|плагина|расширени|extension|компонент|модуль|модуля|микросервис)/i,

    // UI / frontend
    /(html|css|стиль|стилей|стили|tailwind|bootstrap|верстк|вёрстк|вёрстка|дизайн|дизайнер|макет|интерфейс|ui|ux|форм|кнопк|меню|навигаци|анимац|тем|theme|responsive|адаптив|react|vue|angular|svelte|next\.js)/i,

    // Backend / databases / data
    /(express|django|flask|fastapi|next|nuxt|prisma|mongoose|mongodb|postgres|postgresql|mysql|sqlite|redis|база данных|базы данных|бд|таблиц|таблица|csv|json|xml|yaml|sequelize|typeorm|knex)/i,

    // Testing / docs / security
    /(тест|тесты|unit|e2e|покрыти|coverage|jest|playwright|документаци|doc|инструкц|мануал|руководств|readme|безопасност|security|аутентификац|авториз|auth|login|регистрац|пароль|token|jwt)/i,

    // Math / data / visuals
    /(калькулятор|формула|график|визуализаци|дашборд|dashboard|данные|анализ|статистик|таблица|excel|google sheet|отчёт|report)/i,

    // Miscellaneous creation tasks
    /(конфиг|конфигурац|настроен|настройка|настройках|деплой|развёртыван|развертыван|миграц|миграция|сиды|seeds|seed|fixture|мок|mock)/i,

    // Common programming languages / frameworks
    /(javascript|typescript|java|kotlin|swift|rust|go|golang|ruby|php|c\+\+|cpp|csharp|c#|scala|haskell|elixir|dart|flutter|flutter|spring|laravel|rails|nestjs|graphql|apollo|rest|grpc|websocket|socket\.io)/i,

    // Cloud / hosting / networking
    /(aws|amazon|gcp|google cloud|azure|heroku|vercel|netlify|railway|render|supabase|firebase|hosting|хостинг|домен|домена|доменное|хост|хостинг|cloudfront|s3|lambda|vps|cloud|облако)/i,

    // AI / ML / data science
    /(нейросет|нейросеть|ai|ml|machine learning|машинное обучение|model|модель|обучен|трениров|training|dataset|датасет|набор данных|embedding|prompt|prompt engineering|rag|llm|chatbot|chat-bot|gpt|claude|image generation|генераци изображен|stablediffusion)/i,

    // Version control / CI
    /(commit|коммит|пуш|push|pull request|merge|branch|бранч|fork|clone|клонируй|ребаза|rebase|cherry-pick|gitflow|github actions|gitlab ci|bitbucket|subversion|svn)/i,

    // Content / media
    /(изображен|картинк|фото|фотографи|видео|аудио|звук|музык|текст|стать|блог|пост|контент|медиа|thumbnail|превью|иконк|favicon|logo|логотип|баннер|слайдер|карусель|галерея)/i,

    // Commerce / business
    /(платёж|платеж|оплат|оплата|stripe|paypal|корзин|cart|заказ|checkout|подписк|subscription|тариф|pricing|прайс|цена|стоимость|скидк|купон|coupon|товар|товары|каталог|каталога)/i,

    // Notifications / communication
    /(уведомлен|уведомление|push|email|smtp|mailgun|sendgrid|sms|whatsapp|signal|slack|discord|telegram api|сообщен|сообщение|чат|чата|комментарий|комментарии|реакци|лайк|дизлайк)/i,

    // Performance / monitoring
    /(производител|производительность|speed|скорость|быстр|медлен|lazy load|кеширован|кеш|cache|cdn|сжатие|gzip|brotli|minif|bundl|webpack|esbuild|rollup|vite|профайл|profile|monitoring|метрик|logs|logging|sentry|prometheus|grafana)/i,

    // Accessibility / i18n
    /(доступност|accessibility|a11y|скринридер|screen reader|aria|семантик|семантическ|перевод|i18n|локализ|localization|internationalization|мультиязычн|мультиязычный|язык|языка)/i,

    // AI / ML / data science
    /(нейросет|нейросеть|нейронн|ai|машинн обучен|ml|model|модель|обучен|трениров|training|dataset|датасет|embedding|prompt|rag|llm|gpt|claude|генераци изображен|stablediffusion|stable diffusion|dalle|midjourney|chatbot|chat-bot|chat бот)/i,

    // Version control / CI/CD
    /(commit|коммит|пуш|push|pull request|merge|branch|бранч|fork|clone|клонируй|ребаза|rebase|cherry-pick|gitflow|github actions|gitlab ci|bitbucket|svn)/i,

    // Content / media / design
    /(изображен|картинк|фото|фотографи|видео|аудио|звук|музык|текст|стать|блог|пост|контент|медиа|thumbnail|превью|иконк|favicon|logo|логотип|баннер|слайдер|карусель|галерея|шрифт|шрифты|font)/i,

    // Commerce / payments
    /(платёж|платеж|оплат|оплата|stripe|paypal|корзин|cart|заказ|checkout|подписк|subscription|тариф|pricing|прайс|скидк|купон|coupon|товар|товары|каталог|каталога)/i,

    // Notifications / communication
    /(уведомлен|уведомление|push notification|email|smtp|mailgun|sendgrid|sms|whatsapp|signal|slack|discord|сообщен|сообщение|чат|чата|комментарий|комментарии|реакци|лайк|дизлайк)/i,

    // Performance / monitoring / build
    /(производител|производительность|speed|скорость|быстр|медлен|lazy load|кеширован|кеш|cache|cdn|сжатие|gzip|brotli|minif|bundl|webpack|esbuild|rollup|vite|профайл|profile|monitoring|метрик|logs|logging|sentry|prometheus|grafana)/i,

    // Accessibility / internationalization
    /(доступност|accessibility|a11y|скринридер|screen reader|aria|семантик|семантическ|перевод|i18n|локализ|localization|мультиязычн|мультиязычный)/i,

    // Programming languages & frameworks
    /(javascript|typescript|java|kotlin|swift|rust|golang|ruby|php|scala|haskell|elixir|dart|flutter|spring|laravel|rails|nestjs|graphql|apollo|rest|grpc|websocket|socket\.io)/i,

    // Cloud & hosting
    /(aws|amazon|gcp|google cloud|azure|heroku|vercel|netlify|railway|render|supabase|firebase|хостинг|домен|домена|cloudfront|s3|lambda|cloud|облако)/i,

    // Data formats & configs
    /(xml|yaml|yml|toml|ini|properties|env|\.env|\.gitignore|dockerignore|eslint|prettier|tsconfig|babel|postcss)/i,

    // Security
    /(безопасност|security|уязвимост|vulnerabilit|шифрован|encrypt|decrypt|ssl|tls|https|cors|csrf|xss|инъекц|inject|аутентификац|авториз|auth|login|регистрац|пароль|password|token|jwt|oauth|openid)/i,

    // Dev tools & workflow
    /(npm|yarn|pnpm|bun|pip|cargo|gem|composer|make|cmake|gradle|maven|lint|formatter|pre-commit|husky|changelog|release|version|semver)/i,

    // General task verbs (catch-all for "help me with...")
    /(помоги|помогите|помочь|научи|научите|научить|покажи|покажите|показать|объясни|объясните|объяснить|расскажи|расскажите|рассказать|как сделать|как написать|как создать|как добавить|как настроить|как установить|как запустить|как исправить|как работает|как это|как бы|мне нужно|мне надо|хочу чтобы|хочу сделать|хочу создать)/i,
  ]
  if (agentPatterns.some((re) => re.test(raw)) || /(code|script|json|jsx|tsx|py|python|js|node|npm|yarn|vite|react|vue|angular|svelte|css|html|tailwind)/i.test(att)) {
    return { mode: 'agent', reason: 'Нужны инструменты/файлы/код', icon: '🤖' }
  }

  // ── Web patterns: current facts that need live data ──
  const webPatterns = [
    /(курс валют|курс доллара|курс евро|цена на|стоимость товара|котировк акций|новост сегодня|расписан поездов|результат матча|счёт матча|прогноз погоды)/i,
    /(weather forecast|stock price today|exchange rate|live news|current events|today's score)/i,
    /(найди в интернете|поищи в интернете|загугли|что происходит|что нового|что случилось)/i,
  ]
  if (webPatterns.some((re) => re.test(raw))) {
    return { mode: 'web', reason: 'Нужна актуальная информация', icon: '🌐' }
  }

  // ── Default: short text → cheap chat, long text → still cheap unless it has action keywords ──
  if (raw.length <= 1200) {
    return { mode: 'chat', reason: 'Обычный вопрос без инструментов', icon: '💬' }
  }

  return { mode: 'chat', reason: 'Длинный текст, но инструменты не нужны', icon: '💬' }
}
