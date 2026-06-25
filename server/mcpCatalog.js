/**
 * mcpCatalog.js — Sprint 5A
 * Каталог MCP серверов для Marketplace.
 * {{PLACEHOLDER}} в env/args будет заменён значением из формы установки.
 */

export const MCP_CATALOG = [
  // ── DEV ──────────────────────────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    category: 'dev',
    description: 'Issues, PRs, Actions, repos — полный GitHub API',
    envVars: { GITHUB_PERSONAL_ACCESS_TOKEN: { label: 'GitHub Token', placeholder: 'ghp_...', required: true } },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '{{GITHUB_PERSONAL_ACCESS_TOKEN}}' } },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    icon: '📁',
    category: 'dev',
    description: 'Расширенный доступ к файлам — чтение, запись, поиск',
    envVars: {},
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    icon: '🐘',
    category: 'dev',
    description: 'SQL запросы к PostgreSQL базе данных',
    envVars: { DATABASE_URL: { label: 'Database URL', placeholder: 'postgresql://user:pass@host:5432/db', required: true } },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '{{DATABASE_URL}}'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    icon: '🗄️',
    category: 'dev',
    description: 'Работа с SQLite базой данных',
    envVars: { DB_PATH: { label: 'Путь к .db файлу', placeholder: '/workspace/db.sqlite', required: true } },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '{{DB_PATH}}'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    icon: '🔥',
    category: 'dev',
    description: 'Ошибки, события и производительность из Sentry',
    envVars: { SENTRY_AUTH_TOKEN: { label: 'Sentry Auth Token', placeholder: 'sntrys_...', required: true } },
    install: { command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_AUTH_TOKEN: '{{SENTRY_AUTH_TOKEN}}' } },
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    icon: '🎭',
    category: 'dev',
    description: 'Управление браузером через Puppeteer — скриншоты, скрейпинг',
    envVars: {},
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  // ── DEPLOY ───────────────────────────────────────────────────────────────
  {
    id: 'brave-search',
    name: 'Brave Search',
    icon: '🦁',
    category: 'deploy',
    description: 'Поиск в интернете через Brave Search API',
    envVars: { BRAVE_API_KEY: { label: 'Brave API Key', placeholder: 'BSA...', required: true } },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '{{BRAVE_API_KEY}}' } },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'fetch',
    name: 'Web Fetch',
    icon: '🌐',
    category: 'deploy',
    description: 'Загрузка веб-страниц и API через HTTP',
    envVars: {},
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'memory',
    name: 'Memory (Knowledge Graph)',
    icon: '🧠',
    category: 'deploy',
    description: 'Постоянная память через граф знаний',
    envVars: {},
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  // ── PRODUCTIVITY ─────────────────────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    category: 'productivity',
    description: 'Сообщения, каналы и файлы Slack',
    envVars: {
      SLACK_BOT_TOKEN: { label: 'Bot Token (xoxb-...)', placeholder: 'xoxb-...', required: true },
      SLACK_TEAM_ID: { label: 'Team ID (T...)', placeholder: 'T01234567', required: true },
    },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '{{SLACK_BOT_TOKEN}}', SLACK_TEAM_ID: '{{SLACK_TEAM_ID}}' } },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    id: 'notion',
    name: 'Notion',
    icon: '📝',
    category: 'productivity',
    description: 'Страницы, базы данных и блоки Notion',
    envVars: { NOTION_API_TOKEN: { label: 'Notion Integration Token', placeholder: 'secret_...', required: true } },
    install: { command: 'npx', args: ['-y', '@notionhq/mcp'], env: { NOTION_API_TOKEN: '{{NOTION_API_TOKEN}}' } },
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    icon: '📂',
    category: 'productivity',
    description: 'Файлы и папки Google Drive',
    envVars: {
      GOOGLE_CLIENT_ID: { label: 'Client ID', placeholder: '....apps.googleusercontent.com', required: true },
      GOOGLE_CLIENT_SECRET: { label: 'Client Secret', placeholder: 'GOCSPX-...', required: true },
    },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'], env: { GOOGLE_CLIENT_ID: '{{GOOGLE_CLIENT_ID}}', GOOGLE_CLIENT_SECRET: '{{GOOGLE_CLIENT_SECRET}}' } },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    icon: '🗺️',
    category: 'productivity',
    description: 'Геокодирование, маршруты, поиск мест',
    envVars: { GOOGLE_MAPS_API_KEY: { label: 'Google Maps API Key', placeholder: 'AIza...', required: true } },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'], env: { GOOGLE_MAPS_API_KEY: '{{GOOGLE_MAPS_API_KEY}}' } },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps',
  },
  // ── DATABASE ─────────────────────────────────────────────────────────────
  {
    id: 'redis',
    name: 'Redis',
    icon: '🔴',
    category: 'database',
    description: 'Ключ-значение операции с Redis',
    envVars: { REDIS_URL: { label: 'Redis URL', placeholder: 'redis://localhost:6379', required: true } },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis', '{{REDIS_URL}}'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/redis',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    icon: '🐬',
    category: 'database',
    description: 'SQL запросы к MySQL/MariaDB',
    envVars: {
      MYSQL_HOST: { label: 'Host', placeholder: 'localhost', required: true },
      MYSQL_USER: { label: 'User', placeholder: 'root', required: true },
      MYSQL_PASSWORD: { label: 'Password', placeholder: '...', required: true },
      MYSQL_DATABASE: { label: 'Database', placeholder: 'mydb', required: true },
    },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-mysql'], env: { MYSQL_HOST: '{{MYSQL_HOST}}', MYSQL_USER: '{{MYSQL_USER}}', MYSQL_PASSWORD: '{{MYSQL_PASSWORD}}', MYSQL_DATABASE: '{{MYSQL_DATABASE}}' } },
    docsUrl: 'https://github.com/benborla29/mcp-server-mysql',
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    icon: '🍃',
    category: 'database',
    description: 'Операции с MongoDB коллекциями',
    envVars: { MONGODB_URI: { label: 'MongoDB URI', placeholder: 'mongodb://localhost:27017', required: true } },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-mongodb', '{{MONGODB_URI}}'] },
    docsUrl: 'https://github.com/kiliczsh/mcp-mongo-server',
  },
]

export const MCP_CATEGORIES = [
  { id: 'all', label: 'Все' },
  { id: 'dev', label: '💻 Dev' },
  { id: 'deploy', label: '🚀 Web' },
  { id: 'productivity', label: '📋 Продуктивность' },
  { id: 'database', label: '🗄️ Базы данных' },
]

export function getCatalogServer(id) {
  return MCP_CATALOG.find(s => s.id === id) || null
}

export default { MCP_CATALOG, MCP_CATEGORIES, getCatalogServer }
