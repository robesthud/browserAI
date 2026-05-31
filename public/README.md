# 🚀 AI Code Studio

**Full-Stack AI-Powered IDE** — аналог Cursor + Browser AI

## ✨ Возможности

### 🤖 AI Интеграция
- **Универсальный AI адаптер** — поддержка OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, Qwen, Ollama, LM Studio
- **AI автокомплит** — умные подсказки кода в реальном времени
- **AI чат** — помощь с кодом, рефакторинг, объяснения, исправление ошибок
- **AI агент** — генерация целых проектов по описанию

### 📝 Редактор
- **Monaco Editor** — тот же редактор что в VS Code
- **Подсветка синтаксиса** — TypeScript, JavaScript, Python, Go, Rust, и др.
- **Многофайловое редактирование** — табы, сохранение состояния
- **Автосохранение** — изменения сохраняются автоматически

### 🌐 Browser AI
- **Встроенный браузер** — предпросмотр результатов
- **AI управление** — навигация, клики, ввод текста, скриншоты
- **Извлечение данных** — парсинг страниц через Playwright

### 👥 Совместная работа
- **Real-time редактирование** — CRDT через Yjs
- **Курсоры коллег** — видите где редактируют другие
- **Синхронизация** — мгновенные обновления

### 🐙 Git интеграция
- **Клонирование** — любые Git репозитории
- **Коммиты и пуши** — прямо из IDE
- **Ветки** — создание, переключение, слияние
- **История** — просмотр коммитов

### 💻 Терминал
- **Встроенный терминал** — выполнение команд
- **Code Runner** — безопасное выполнение кода в Docker
- **Поддержка языков** — Python, JavaScript, TypeScript, Go, Rust

---

## 🛠️ Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (React)                         │
│  Monaco Editor │ AI Chat │ Agent Panel │ Browser │ Terminal  │
└─────────────────────────────────────────────────────────────┘
                              │
                    WebSocket + REST API
                              │
┌─────────────────────────────────────────────────────────────┐
│                   Backend (Node.js + Fastify)                │
│  Auth │ Projects │ Files │ Git │ AI Adapter │ WebSocket     │
└─────────────────────────────────────────────────────────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
┌──────┴──────┐    ┌──────────┴──────────┐    ┌─────┴─────┐
│ Code Runner │    │    Browser Agent    │    │ Collab    │
│ (FastAPI)   │    │   (Playwright)      │    │ (Yjs)     │
└─────────────┘    └─────────────────────┘    └───────────┘
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│              PostgreSQL │ Redis │ Ollama (optional)          │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Быстрый старт

### Требования
- Docker & Docker Compose
- Node.js 20+ (для разработки)

### 1. Клонируйте репозиторий
```bash
git clone https://github.com/your-org/ai-code-studio.git
cd ai-code-studio
```

### 2. Настройте переменные окружения
```bash
cp .env.example .env
# Отредактируйте .env и добавьте API ключи
```

### 3. Запустите через Docker Compose
```bash
docker-compose up -d --build
```

### 4. Откройте в браузере
```
http://localhost
```

---

## 🔧 Конфигурация AI провайдеров

### OpenAI
```env
OPENAI_API_KEY=sk-...
```

### Anthropic (Claude)
```env
ANTHROPIC_API_KEY=sk-ant-...
```

### Google (Gemini)
```env
GOOGLE_AI_API_KEY=AIzaSy...
```

### Groq (Fast Inference)
```env
GROQ_API_KEY=gsk_...
```

### Ollama (Local)
```bash
# Запустите с профилем local-ai
docker-compose --profile local-ai up -d

# Загрузите модель
docker exec aicode-ollama ollama pull llama3.2
```

---

## 📚 API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Регистрация |
| POST | `/api/auth/login` | Вход |
| POST | `/api/auth/github` | GitHub OAuth |
| GET | `/api/projects` | Список проектов |
| POST | `/api/projects` | Создать проект |
| GET | `/api/projects/:id` | Получить проект |
| GET | `/api/files/:id` | Содержимое файла |
| PUT | `/api/files/:id` | Обновить файл |
| POST | `/api/git/clone` | Клонировать репо |
| POST | `/api/git/commit` | Создать коммит |
| POST | `/api/code/run` | Выполнить код |

### WebSocket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `ai:chat:stream` | → server | Отправить сообщение |
| `ai:chat:chunk` | ← server | Токен ответа |
| `ai:completion` | → server | Запрос автокомплита |
| `collab:edit` | → server | CRDT операция |
| `collab:cursor` | → server | Позиция курсора |
| `browser:action` | → server | Команда браузеру |

---

## 🏗️ Разработка

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
npm install
npx prisma generate
npx prisma db push
npm run dev
```

### Code Runner
```bash
cd code-runner
pip install -r requirements.txt
uvicorn code_runner:app --reload
```

---

## 📁 Структура проекта

```
ai-code-studio/
├── frontend/           # React + Vite + Tailwind
│   ├── src/
│   │   ├── components/
│   │   ├── stores/
│   │   ├── services/
│   │   └── App.tsx
│   └── Dockerfile
├── backend/            # Node.js + Fastify + Prisma
│   ├── src/
│   │   ├── routes/
│   │   ├── services/
│   │   └── websocket/
│   ├── prisma/
│   └── Dockerfile
├── code-runner/        # FastAPI + Docker SDK
│   ├── code_runner.py
│   └── Dockerfile
├── browser-agent/      # Playwright + MCP
│   └── Dockerfile
├── collaboration/      # Yjs WebSocket
│   └── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## 🔒 Безопасность

- **JWT аутентификация** — токены с истечением
- **OAuth** — вход через GitHub
- **Изолированное выполнение** — код запускается в Docker контейнерах
- **Ограничения ресурсов** — CPU, RAM, таймаут
- **CORS** — настраиваемые домены

---

## 📄 Лицензия

MIT License — используйте свободно!

---

## 🙏 Благодарности

- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [Yjs](https://yjs.dev/)
- [Playwright](https://playwright.dev/)
- [Fastify](https://fastify.dev/)
- [Prisma](https://prisma.io/)
