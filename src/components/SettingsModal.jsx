import { useEffect, useRef, useState } from 'react'
import {
  IconClose,
  IconTrash,
  IconEye,
  IconEyeOff,
  IconDownload,
  IconUpload,
  IconLock,
  IconUnlock,
} from '../icons.jsx'
import { emptyKey, getActiveKey, getSelectedModel } from '../lib/settings.js'
import { exportKeysToFile, importKeysFromFile } from '../lib/keyfile.js'

const inputCls =
  'w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-[13px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none'

const PROVIDER_PRESETS = [
  // --- Официальные API (Bearer токен) ---
  {
    id: 'openai',
    group: 'api',
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
  },
  {
    id: 'deepseek-api',
    group: 'api',
    label: 'DeepSeek API',
    name: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    authType: 'bearer',
  },
  {
    id: 'gemini',
    group: 'api',
    label: 'Gemini API',
    name: 'Gemini API',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authType: 'bearer',
    hint: 'Ключ: console.cloud.google.com → APIs → Gemini API → Credentials',
  },
  {
    id: 'mistral-api',
    group: 'api',
    label: 'Mistral API',
    name: 'Mistral API',
    baseUrl: 'https://api.mistral.ai/v1',
    authType: 'bearer',
  },
  {
    id: 'groq',
    group: 'api',
    label: 'Groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authType: 'bearer',
    hint: 'Ключ: console.groq.com → API Keys (бесплатный tier доступен)',
  },
  {
    id: 'together',
    group: 'api',
    label: 'Together AI',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    authType: 'bearer',
  },
  {
    id: 'openrouter',
    group: 'api',
    label: 'OpenRouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authType: 'bearer',
    hint: 'openrouter.ai — доступ к 100+ моделям через один ключ',
  },
  // --- Сессионные токены (веб-интерфейс) ---
  {
    id: 'deepseek-web',
    group: 'web',
    label: '🍪 DeepSeek Web',
    name: 'DeepSeek Web (сессия)',
    baseUrl: 'https://chat.deepseek.com/api/v0',
    model: 'deepseek_chat',
    authType: 'bearer',
    extraHeaders: { 'Referer': 'https://chat.deepseek.com/', 'Origin': 'https://chat.deepseek.com', 'x-app-version': '20241129' },
    hint: 'F12 → Network → запрос к /chat/completion → заголовок Authorization',
  },
  {
    id: 'grok-web',
    group: 'web',
    label: '🍪 Grok Web',
    name: 'Grok Web (сессия)',
    baseUrl: 'https://grok.com/api',
    model: 'grok-3',
    authType: 'bearer',
    extraHeaders: { 'Referer': 'https://grok.com/', 'Origin': 'https://grok.com' },
    hint: 'F12 → Network → запрос к /chat → заголовок Authorization',
  },
  {
    id: 'claude-web',
    group: 'web',
    label: '🍪 Claude Web',
    name: 'Claude Web (сессия)',
    baseUrl: 'https://claude.ai/api',
    model: 'claude-3-5-sonnet-20241022',
    authType: 'custom',
    authHeader: 'Cookie',
    extraHeaders: { 'Referer': 'https://claude.ai/', 'Origin': 'https://claude.ai' },
    hint: 'F12 → Network → любой запрос к /api → скопируй весь заголовок Cookie',
  },
  {
    id: 'gemini-web',
    group: 'web',
    label: '🍪 Gemini Web',
    name: 'Gemini Web (сессия)',
    baseUrl: 'https://gemini.google.com/api',
    model: 'gemini-2.0-flash',
    authType: 'custom',
    authHeader: 'Cookie',
    extraHeaders: {
      'Referer': 'https://gemini.google.com/',
      'Origin': 'https://gemini.google.com',
      'x-goog-api-client': 'gl-js/ fire/0.0.0',
    },
    hint: 'F12 → Network → запрос к /api → вкладка Headers → скопируй весь заголовок Cookie\n\nТакже можно попробовать AI Studio:\nBase URL: https://aistudio.google.com/api/v1\nТокен: заголовок x-goog-api-key или Cookie',
  },
  {
    id: 'chatgpt-web',
    group: 'web',
    label: '🍪 ChatGPT Web',
    name: 'ChatGPT Web (сессия)',
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-4o',
    authType: 'bearer',
    extraHeaders: {
      'Referer': 'https://chatgpt.com/',
      'Origin': 'https://chatgpt.com',
    },
    hint: 'F12 → Network → запрос к /backend-api/conversation → заголовок Authorization\n\nТокен начинается с eyJ... (JWT)',
  },
  {
    id: 'mistral-web',
    group: 'web',
    label: '🍪 Mistral Web',
    name: 'Mistral Chat (сессия)',
    baseUrl: 'https://chat.mistral.ai/api',
    model: 'mistral-large-latest',
    authType: 'bearer',
    extraHeaders: {
      'Referer': 'https://chat.mistral.ai/',
      'Origin': 'https://chat.mistral.ai',
    },
    hint: 'F12 → Network → запрос к /api → заголовок Authorization',
  },
  // --- Локальные мосты ---
  {
    id: 'arena-bridge',
    group: 'local',
    label: '🌉 Arena.ai Bridge',
    name: 'Arena.ai (через LMArenaBridge)',
    baseUrl: 'http://localhost:8000/api/v1',
    model: '',
    authType: 'bearer',
    hint: `Arena.ai требует локальный прокси LMArenaBridge.\n\n1. Получи токен:\n   F12 → Application → Cookies → arena.ai\n   Скопируй куку arena-auth-prod-v1 (начинается с base64-)\n\n2. Установи прокси на устройстве (Termux/PC):\n   git clone https://github.com/CloudWaddie/LMArenaBridge\n   cd LMArenaBridge\n   pip install -r requirements.txt\n   echo '{"auth_token":"ТВОЙ_ТОКЕН"}' > config.json\n   python -m src.main\n\n3. Прокси запустится на localhost:8000\n   Base URL уже заполнен — просто нажми Проверить`,
  },
  {
    id: 'custom-web',
    group: 'local',
    label: '🔧 Свой сайт',
    name: 'Кастомный сайт',
    baseUrl: '',
    model: '',
    authType: 'bearer',
    hint: 'F12 → Network → найди запрос к AI → скопируй URL и заголовок авторизации',
  },
]

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] text-cream-soft">{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] text-cream-faint">{hint}</span>
      )}
    </label>
  )
}

// Поле ключа с кнопкой-глазом
function SecretField({ label, hint, value, onChange }) {
  const [show, setShow] = useState(false)
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] text-cream-soft">{label}</span>
      <div className="relative">
        <input
          className={`${inputCls} pr-10`}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder="sk-..."
          autoComplete="off"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-cream-faint transition-colors hover:bg-graphite-750 hover:text-cream"
          title={show ? 'Скрыть' : 'Показать'}
          tabIndex={-1}
        >
          {show ? <IconEyeOff /> : <IconEye />}
        </button>
      </div>
      {hint && (
        <span className="mt-1 block text-[11px] text-cream-faint">{hint}</span>
      )}
    </label>
  )
}

function KeyRow({ k, active, onSelect, onEdit, onDelete }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors
        ${active ? 'border-cream/40 bg-graphite-750' : 'border-white/10 hover:bg-graphite-750/60'}`}
    >
      <button
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={active ? 'Активный ключ' : 'Сделать активным'}
      >
        <span
          className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border
            ${active ? 'border-cream bg-cream' : 'border-cream-faint'}`}
        >
          {active && <span className="h-1.5 w-1.5 rounded-full bg-graphite-900" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-cream">
            {k.name || 'Без имени'}
          </span>
          <span className="block truncate text-[11px] text-cream-faint">
            {getSelectedModel(k) || 'модель не выбрана'}
            {k.availableModels?.length ? ` · моделей: ${k.availableModels.length}` : ''}
            {' · '}
            {k.apiKey ? '••••' + k.apiKey.slice(-4) : 'нет ключа'}
          </span>
        </span>
      </button>
      <button
        onClick={onEdit}
        className="shrink-0 rounded-md px-2 py-1 text-[11px] text-cream-dim transition-colors hover:bg-graphite-700 hover:text-cream"
      >
        Изменить
      </button>
      <button
        onClick={onDelete}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-cream-faint transition-colors hover:bg-graphite-700 hover:text-cream"
        title="Удалить ключ"
      >
        <IconTrash />
      </button>
    </div>
  )
}

function KeyEditor({ initial, onSave, onCancel, onValidate }) {
  const [form, setForm] = useState(initial)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState(null)
  const modelRef = useRef(initial.model || '')

  const set = (field) => (e) => {
    const value = e.target.value
    setForm((f) => {
      const next = { ...f, [field]: value }
      // При смене baseUrl или apiKey сбрасываем список моделей
      if (field === 'baseUrl' || field === 'apiKey') {
        next.availableModels = []
        next.model = ''
        // authType НЕ сбрасываем — пользователь мог специально выбрать cookie/custom
      }
      return next
    })
    setResult(null)
  }

  // БАГ 7 ИСПРАВЛЕН: authHeader сбрасываем только если пресет явно его задаёт
  const applyPreset = (preset) => {
    setForm((f) => ({
      ...f,
      name: f.name || preset.name,
      baseUrl: preset.baseUrl,
      availableModels: [],
      model: preset.model || '',
      authType: preset.authType || 'bearer',
      // Сбрасываем authHeader только если пресет явно его задаёт
      authHeader: preset.authHeader !== undefined ? preset.authHeader : f.authHeader,
      // extraHeaders из пресета (если заданы)
      extraHeaders: preset.extraHeaders !== undefined ? preset.extraHeaders : (f.extraHeaders || {}),
    }))
    setResult(null)
    if (preset.hint) alert(`💡 Как получить токен:\n\n${preset.hint}`)
  }

  // Применяет результат валидации к форме и возвращает обновлённую форму
  const applyValidationResult = (r) => {
    let updatedForm = null
    setForm((f) => {
      const models = (r.ok && Array.isArray(r.models) && r.models.length > 0) ? r.models : f.availableModels || []
      const preferredModel =
        (r.preferredModel && models.includes(r.preferredModel) && r.preferredModel) ||
        (models.includes(f.model) ? f.model : null) ||
        models[0] || f.model || ''
      updatedForm = {
        ...f,
        availableModels: models.length > 0 ? models : (f.model ? [f.model] : []),
        model: preferredModel,
      }
      return updatedForm
    })
    return updatedForm
  }

  // Проверка + автосохранение: после успешной валидации сразу сохраняет ключ
  const check = async () => {
    setChecking(true)
    setResult(null)
    try {
      const r = await onValidate({
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
        authType: form.authType || 'bearer',
        authHeader: form.authHeader || '',
      })
      setResult(r)
      const updated = applyValidationResult(r)
      // Автосохранение при успешной проверке
      if (r.ok && updated && updated.apiKey?.trim() && updated.baseUrl?.trim() && updated.model?.trim()) {
        onSave(updated)
      }
    } finally {
      setChecking(false)
    }
  }

  const canSave =
    form.apiKey.trim() &&
    form.baseUrl.trim() &&
    (form.model.trim() || form.availableModels?.length > 0)

  useEffect(() => {
    modelRef.current = form.model || ''
  }, [form.model])

  // Авто-валидация при вводе ключа/URL
  // Для сессионных токенов (cookie/custom) тоже запускаем, но только если модель уже указана
  useEffect(() => {
    const isSession = form.authType === 'cookie' || form.authType === 'custom'
    const hasCredentials = form.baseUrl.trim() && form.apiKey.trim()
    if (!hasCredentials) return undefined
    // Для сессионных — нужна модель (из пресета). Без модели валидация бесполезна.
    if (isSession && !modelRef.current) return undefined

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setChecking(true)
      try {
        const r = await onValidate(
          {
            baseUrl: form.baseUrl,
            apiKey: form.apiKey,
            model: modelRef.current,
            authType: form.authType || 'bearer',
            authHeader: form.authHeader || '',
          },
          controller.signal,
        )
        if (controller.signal.aborted) return
        setResult(r)
        const updated = applyValidationResult(r)
        // Автосохранение при успешной авто-валидации
        if (r.ok && updated && updated.apiKey?.trim() && updated.baseUrl?.trim() && updated.model?.trim()) {
          onSave(updated)
        }
      } catch {
        /* ignore auto-fetch errors */
      } finally {
        if (!controller.signal.aborted) setChecking(false)
      }
    }, 700)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.baseUrl, form.apiKey, form.authType, onValidate])

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-graphite-900/60 p-3">
      {/* БАГ 5 ИСПРАВЛЕН: правильная фильтрация пресетов по group */}
      <div>
        <div className="mb-2 text-[12px] text-cream-faint">Официальные API</div>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_PRESETS.filter((p) => p.group === 'api').map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="mt-2 mb-1 text-[12px] text-cream-faint">Сессионные токены (веб-интерфейс)</div>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_PRESETS.filter((p) => p.group === 'web').map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-1.5 text-[12px] text-amber-300 transition-colors hover:border-amber-400/40 hover:bg-amber-400/10"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="mt-2 mb-1 text-[12px] text-cream-faint">Локальные и кастомные</div>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_PRESETS.filter((p) => p.group === 'local').map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className="rounded-lg border border-blue-400/20 bg-blue-400/5 px-2.5 py-1.5 text-[12px] text-blue-300 transition-colors hover:border-blue-400/40 hover:bg-blue-400/10"
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Инструкция по сессионным токенам */}
        <div className="mt-2 rounded-lg border border-amber-400/15 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/80 space-y-1">
          <div className="font-medium text-amber-300">💡 Как получить токен с любого сайта:</div>
          <div>1. Открой сайт и залогинься</div>
          <div>2. Нажми <span className="font-mono bg-black/20 px-1 rounded">F12</span> → вкладка <span className="font-mono bg-black/20 px-1 rounded">Network</span></div>
          <div>3. Отправь сообщение в чате сайта</div>
          <div>4. Найди запрос к API (обычно <span className="font-mono bg-black/20 px-1 rounded">/chat</span> или <span className="font-mono bg-black/20 px-1 rounded">/completion</span>)</div>
          <div>5. Вкладка <span className="font-mono bg-black/20 px-1 rounded">Headers</span> → скопируй <span className="font-mono bg-black/20 px-1 rounded">Authorization</span> или <span className="font-mono bg-black/20 px-1 rounded">Cookie</span></div>
          <div className="text-amber-300/70 pt-0.5">⚠ Токены протухают через дни/недели. При ошибке 401 — обнови.</div>
        </div>
      </div>

      <Field label="Имя ключа" hint="Чтобы различать ключи в списке">
        <input
          className={inputCls}
          value={form.name}
          onChange={set('name')}
          placeholder="Напр. OpenAI личный, Рабочий, Локальный…"
        />
      </Field>
      <Field label="Base URL">
        <input
          className={inputCls}
          value={form.baseUrl}
          onChange={set('baseUrl')}
          placeholder="https://api.openai.com/v1"
        />
      </Field>

      {/* Тип авторизации */}
      <Field label="Тип авторизации">
        <select
          className={inputCls}
          value={form.authType || 'bearer'}
          onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value }))}
        >
          <option value="bearer">Bearer Token (стандартный API)</option>
          <option value="cookie">Cookie сессии (веб-интерфейс)</option>
          <option value="custom">Кастомный заголовок</option>
        </select>
      </Field>

      {form.authType === 'custom' && (
        <Field label="Имя заголовка" hint="Напр. X-Auth-Token, Authorization, Api-Key">
          <input
            className={inputCls}
            value={form.authHeader || ''}
            onChange={(e) => setForm((f) => ({ ...f, authHeader: e.target.value }))}
            placeholder="X-Auth-Token"
          />
        </Field>
      )}

      <SecretField
        label={
          form.authType === 'cookie'
            ? 'Cookie сессии'
            : form.authType === 'custom'
            ? 'Значение токена'
            : 'API-ключ'
        }
        hint={
          form.authType === 'cookie'
            ? 'Вставь Cookie из браузера (F12 → Network → заголовок Cookie)'
            : form.authType === 'custom'
            ? 'Значение которое подставится в кастомный заголовок'
            : 'Хранится в БД на сервере (или локально, если сервер недоступен).'
        }
        value={form.apiKey}
        onChange={set('apiKey')}
      />

      {/* Выбор модели — дропдаун если список получен, иначе текстовый ввод */}
      <Field
        label="Модель"
        hint={form.availableModels?.length
          ? `Доступно моделей: ${form.availableModels.length}`
          : 'Введите вручную или нажмите «Проверить» для автозагрузки списка'}
      >
        {form.availableModels?.length > 0 ? (
          <select
            className={inputCls}
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          >
            {form.availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            className={inputCls}
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder="gpt-4o, claude-3-5-sonnet, gemini-2.0-flash…"
          />
        )}
      </Field>

      {/* Путь к тексту в ответе — для нестандартных API */}
      {(form.authType === 'cookie' || form.authType === 'custom') && (
        <Field
          label="Путь к ответу в JSON (необязательно)"
          hint='Оставь пустым — приложение само попробует стандартные пути. Или укажи вручную, напр: choices.0.message.content'
        >
          <input
            className={inputCls}
            value={form.responsePath || ''}
            onChange={(e) => setForm((f) => ({ ...f, responsePath: e.target.value }))}
            placeholder="choices.0.message.content"
          />
        </Field>
      )}

      {/* Доп. заголовки — для защиты от бана при сессионных токенах */}
      {(form.authType === 'cookie' || form.authType === 'custom') && (
        <div className="rounded-xl border border-white/5 bg-graphite-900/40 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-cream-soft">Дополнительные заголовки</span>
            <span className="text-[11px] text-cream-faint">анти-бан</span>
          </div>
          <div className="text-[11px] text-cream-faint leading-relaxed">
            Добавь заголовки которые браузер отправляет автоматически — это снижает риск блокировки.
            Формат: <span className="font-mono bg-black/20 px-1 rounded">Заголовок: Значение</span> (каждый с новой строки)
          </div>
          <textarea
            className={`${inputCls} resize-none font-mono text-[12px]`}
            rows={4}
            placeholder={"Referer: https://chat.deepseek.com/\nOrigin: https://chat.deepseek.com\nx-app-version: 20241129"}
            value={
              Object.entries(form.extraHeaders || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
            }
            onChange={(e) => {
              const lines = e.target.value.split('\n')
              const parsed = {}
              for (const line of lines) {
                const idx = line.indexOf(':')
                if (idx < 1) continue
                const k = line.slice(0, idx).trim()
                const v = line.slice(idx + 1).trim()
                if (k && v) parsed[k] = v
              }
              setForm((f) => ({ ...f, extraHeaders: parsed }))
            }}
          />
          {/* Быстрые шаблоны для популярных сайтов */}
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-cream-faint mr-1">Шаблоны:</span>
            {[
              { label: 'DeepSeek', headers: { 'Referer': 'https://chat.deepseek.com/', 'Origin': 'https://chat.deepseek.com', 'x-app-version': '20241129' } },
              { label: 'Grok', headers: { 'Referer': 'https://grok.com/', 'Origin': 'https://grok.com' } },
              { label: 'Claude', headers: { 'Referer': 'https://claude.ai/', 'Origin': 'https://claude.ai' } },
              { label: 'Gemini', headers: { 'Referer': 'https://gemini.google.com/', 'Origin': 'https://gemini.google.com', 'x-goog-api-client': 'gl-js/ fire/0.0.0' } },
              { label: 'ChatGPT', headers: { 'Referer': 'https://chatgpt.com/', 'Origin': 'https://chatgpt.com' } },
              { label: 'Mistral', headers: { 'Referer': 'https://chat.mistral.ai/', 'Origin': 'https://chat.mistral.ai' } },
            ].map((tpl) => (
              <button
                key={tpl.label}
                type="button"
                onClick={() => setForm((f) => ({ ...f, extraHeaders: { ...f.extraHeaders, ...tpl.headers } }))}
                className="rounded-lg border border-white/10 bg-graphite-800/60 px-2 py-0.5 text-[11px] text-cream-faint transition-colors hover:border-white/20 hover:text-cream-soft"
              >
                {tpl.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, extraHeaders: {} }))}
              className="rounded-lg border border-red-500/20 px-2 py-0.5 text-[11px] text-red-400/70 transition-colors hover:border-red-400/40 hover:text-red-300"
            >
              Очистить
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          className={`rounded-lg px-3 py-2 text-[12px]
            ${
              result.ok
                ? 'border border-green-500/30 bg-green-500/10 text-green-300'
                : 'border border-red-500/30 bg-red-500/10 text-red-300'
            }`}
        >
          <div>
            {result.ok ? '✓ ' : '⚠ '}
            {result.message}
          </div>
          {result.ok && form.model && (
            <div className="mt-1 text-[11px] text-green-200/90">
              Выбранная модель: {form.model}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          onClick={check}
          disabled={checking || !form.apiKey.trim() || !form.baseUrl.trim()}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
        >
          {checking ? 'Загрузка…' : 'Проверить / обновить модели'}
        </button>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
          >
            Отмена
          </button>
          <button
            onClick={() => canSave && onSave(form)}
            disabled={!canSave}
            className="rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
          >
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- Vault (шифрование ключей) ----

function UnlockScreen({ onUnlock }) {
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const unlock = async () => {
    if (!pass) return
    setLoading(true)
    setError('')
    try {
      await onUnlock(pass)
    } catch (e) {
      setError(e.message || 'Неверный пароль')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3 py-4 text-center">
      <div className="text-[32px]">🔒</div>
      <div className="text-[14px] text-cream">Хранилище заблокировано</div>
      <div className="text-[12px] text-cream-faint">Введите мастер-пароль для разблокировки</div>
      <input
        type="password"
        className={inputCls + ' text-center'}
        placeholder="Мастер-пароль"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && unlock()}
        autoFocus
      />
      {error && <div className="text-[12px] text-red-300">{error}</div>}
      <button
        onClick={unlock}
        disabled={loading || !pass}
        className="w-full rounded-lg bg-cream px-4 py-2 text-[13px] font-medium text-graphite-900 transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-40"
      >
        {loading ? 'Проверка…' : 'Разблокировать'}
      </button>
    </div>
  )
}

function VaultSection({ vault, onSetup, onLock, onChange, onDisable, onAutolock, onBackup, onRestore }) {
  const [pass, setPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState(null)
  const fileRef = useRef(null)

  const wrap = async (fn) => {
    setLoading(true)
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: 'Готово' })
      setPass('')
      setNewPass('')
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Ошибка' })
    } finally {
      setLoading(false)
    }
  }

  const handleRestore = async (file) => {
    if (!file) return
    try {
      const text = await file.text()
      const backup = JSON.parse(text)
      await wrap(() => onRestore(backup))
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Ошибка восстановления' })
    }
  }

  return (
    <section className="space-y-3 border-t border-white/5 pt-4">
      <h3 className="text-[13px] font-medium text-cream">
        🔐 Шифрование ключей
      </h3>

      {!vault.enabled ? (
        <div className="space-y-2">
          <p className="text-[12px] text-cream-faint">
            Мастер-пароль шифрует ваши API-ключи в БД (AES-256-GCM). Без пароля — ключи в открытом виде.
          </p>
          <input
            type="password"
            className={inputCls}
            placeholder="Новый мастер-пароль (мин. 10 символов)"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          <button
            onClick={() => wrap(() => onSetup(pass))}
            disabled={loading || !pass}
            className="w-full rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
          >
            Включить шифрование
          </button>
        </div>
      ) : vault.locked ? (
        <UnlockScreen onUnlock={async (p) => { await onSetup(p) }} />
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2">
            <span className="text-green-400">🔓</span>
            <span className="text-[12px] text-green-300">Хранилище разблокировано</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => wrap(onLock)}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
            >
              <IconLock /> Заблокировать
            </button>
            <button
              onClick={onBackup}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
            >
              <IconDownload /> Бэкап
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
            >
              <IconUpload /> Восстановить
            </button>
            <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { handleRestore(e.target.files?.[0]); e.target.value = '' }} />
          </div>

          <div className="space-y-1.5">
            <input type="password" className={inputCls} placeholder="Новый мастер-пароль" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
            <div className="flex gap-2">
              <button
                onClick={() => wrap(() => onChange(newPass))}
                disabled={loading || !newPass}
                className="flex-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
              >
                Сменить пароль
              </button>
              <button
                onClick={() => { if (window.confirm('Отключить шифрование? Ключи будут в открытом виде.')) wrap(onDisable) }}
                disabled={loading}
                className="flex-1 rounded-lg border border-red-500/20 px-2.5 py-1.5 text-[11px] text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-50"
              >
                Отключить
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-cream-faint">Автоблокировка</span>
            <select
              className="rounded-lg border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream"
              value={vault.autolockMinutes ?? 0}
              onChange={(e) => wrap(() => onAutolock(Number(e.target.value)))}
            >
              <option value={0}>Выкл</option>
              <option value={5}>5 мин</option>
              <option value={15}>15 мин</option>
              <option value={30}>30 мин</option>
              <option value={60}>60 мин</option>
            </select>
          </div>
        </div>
      )}

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-[12px] ${msg.ok ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>
          {msg.text}
        </div>
      )}
    </section>
  )
}

export default function SettingsModal({
  open,
  settings,
  online,
  vault,
  onSaveKey,
  onDeleteKey,
  onActivateKey,
  onSetParams,
  onImportKeys,
  onValidateKey,
  onVaultSetup,
  onVaultUnlock,
  onVaultLock,
  onVaultChange,
  onVaultDisable,
  onVaultAutolock,
  onVaultBackup,
  onVaultRestore,
  onClose,
}) {
  const [editing, setEditing] = useState(null) // null | {key}
  const [importMsg, setImportMsg] = useState(null)
  const fileRef = useRef(null)

  if (!open) return null

  const active = getActiveKey(settings)

  const handleImport = async (file) => {
    if (!file) return
    setImportMsg(null)
    try {
      const { keys, activeKeyId } = await importKeysFromFile(file)
      await onImportKeys(keys, activeKeyId)
      setImportMsg({ ok: true, text: `Импортировано ключей: ${keys.length}` })
    } catch (e) {
      setImportMsg({ ok: false, text: e.message || 'Ошибка импорта' })
    }
  }

  const saveKey = async (key) => {
    await onSaveKey(key)
    setEditing(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-graphite-800 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="text-[15px] text-cream">Настройки</span>
            <span
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]
                ${
                  online
                    ? 'bg-green-500/15 text-green-300'
                    : 'bg-graphite-700 text-cream-faint'
                }`}
              title={
                online
                  ? 'Ключи сохраняются в базе данных на сервере'
                  : 'Сервер недоступен — ключи сохраняются локально в браузере'
              }
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-green-400' : 'bg-cream-faint'}`}
              />
              {online ? 'БД' : 'локально'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
          >
            <IconClose />
          </button>
        </div>

        <div className="thin-scroll max-h-[72vh] space-y-5 overflow-y-auto px-5 py-4">
          {/* ---- Хранилище заблокировано: экран разблокировки ---- */}
          {vault.enabled && vault.locked ? (
            <UnlockScreen onUnlock={onVaultUnlock} />
          ) : (
          <>
          {/* ---- Менеджер ключей ---- */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-medium text-cream">API-ключи</h3>
              {!editing && (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => exportKeysToFile(settings)}
                    disabled={settings.keys.length === 0}
                    className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream disabled:opacity-40"
                    title="Экспорт ключей в JSON"
                  >
                    <IconDownload /> Экспорт
                  </button>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream"
                    title="Импорт ключей из JSON"
                  >
                    <IconUpload /> Импорт
                  </button>
                  <button
                    onClick={() => setEditing({ key: emptyKey() })}
                    className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream"
                  >
                    + Добавить
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(e) => {
                      handleImport(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                </div>
              )}
            </div>

            {importMsg && (
              <div
                className={`rounded-lg px-3 py-2 text-[12px]
                  ${
                    importMsg.ok
                      ? 'border border-green-500/30 bg-green-500/10 text-green-300'
                      : 'border border-red-500/30 bg-red-500/10 text-red-300'
                  }`}
              >
                {importMsg.text}
              </div>
            )}

            {editing ? (
              <KeyEditor
                initial={editing.key}
                onSave={saveKey}
                onCancel={() => setEditing(null)}
                onValidate={onValidateKey}
              />
            ) : settings.keys.length === 0 ? (
              <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[12px] text-cream-faint">
                Нет сохранённых ключей. Нажмите «+ Добавить» или импортируйте JSON.
              </p>
            ) : (
              <div className="space-y-2">
                {settings.keys.map((k) => (
                  <KeyRow
                    key={k.id}
                    k={k}
                    active={active?.id === k.id}
                    onSelect={() => onActivateKey(k.id)}
                    onEdit={() => setEditing({ key: { ...k } })}
                    onDelete={() => {
                      if (window.confirm(`Удалить ключ «${k.name || 'Без имени'}»?`)) onDeleteKey(k.id)
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ---- Параметры генерации ---- */}
          <section className="space-y-4 border-t border-white/5 pt-4">
            <h3 className="text-[13px] font-medium text-cream">
              Параметры генерации
            </h3>
            <label className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] text-cream-soft">Use web AI</div>
                <div className="text-[11px] text-cream-faint">
                  Для больших запросов агент сможет искать актуальную информацию в интернете.
                </div>
              </div>
              <button
                onClick={() => onSetParams({ useWebAI: !settings.useWebAI })}
                role="switch"
                aria-checked={settings.useWebAI}
                className={`relative shrink-0 h-6 w-11 rounded-full transition-colors ${
                  settings.useWebAI ? 'bg-cream' : 'bg-graphite-600'
                }`}
              >
                <span
                  className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-graphite-900 shadow transition-transform ${
                    settings.useWebAI ? 'translate-x-[22px]' : 'translate-x-[3px]'
                  }`}
                />
              </button>
            </label>
            <Field label="Системный промпт">
              <textarea
                className={`${inputCls} resize-none`}
                rows={3}
                value={settings.systemPrompt}
                onChange={(e) => onSetParams({ systemPrompt: e.target.value })}
              />
            </Field>
            <Field label={`Temperature: ${settings.temperature}`}>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={settings.temperature}
                onChange={(e) =>
                  onSetParams({ temperature: parseFloat(e.target.value) })
                }
                className="w-full accent-cream"
              />
            </Field>
            <label className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-cream-soft">
                Потоковый вывод (stream)
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={settings.stream}
                onClick={() => onSetParams({ stream: !settings.stream })}
                className={`relative shrink-0 h-6 w-11 rounded-full transition-colors ${
                  settings.stream ? 'bg-cream' : 'bg-graphite-600'
                }`}
              >
                <span
                  className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-graphite-900 shadow transition-transform ${
                    settings.stream ? 'translate-x-[22px]' : 'translate-x-[3px]'
                  }`}
                />
              </button>
            </label>
          </section>
          </>
          )}

          {/* ---- Шифрование (только при доступном сервере) ---- */}
          {online && (
            <VaultSection
              vault={vault}
              onSetup={onVaultSetup}
              onLock={onVaultLock}
              onChange={onVaultChange}
              onDisable={onVaultDisable}
              onAutolock={onVaultAutolock}
              onBackup={onVaultBackup}
              onRestore={onVaultRestore}
            />
          )}
        </div>

        <div className="flex justify-end border-t border-white/5 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-lg bg-cream px-4 py-2 text-[13px] font-medium text-graphite-900 transition-transform hover:scale-[1.02] active:scale-95"
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}
