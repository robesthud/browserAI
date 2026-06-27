import { lookupProviderTier, providerBadgeClass, providerBadgeText } from '../lib/providerSupport.js'
import { useEffect, useRef, useState, useMemo } from 'react'
import {
  IconClose,
  IconTrash,
  IconEye,
  IconEyeOff,
  IconDownload,
  IconUpload,
  IconLock,
} from '../icons.jsx'
import { emptyKey, getActiveKey, getSelectedModel } from '../lib/settings.js'
import { exportKeysToFile, importKeysFromFile } from '../lib/keyfile.js'
import AgentSettingsSection from './AgentSettingsSection.jsx'

const inputCls =
  'w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-[13px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none'

function devtoolsEnabled() {
  try { return localStorage.getItem('browserai.devtools') === '1' }
  catch { return false }
}

const PROVIDER_PRESETS = [
  // --- Официальные API (Bearer токен) ---
  {
    id: 'openai',
    group: 'api',
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'bigmodel',
    group: 'api',
    label: 'Zhipu AI (BigModel)',
    name: 'Zhipu AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    id: 'deepseek-api',
    group: 'api',
    label: 'DeepSeek API',
    name: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
  },
  {
    id: 'gemini',
    group: 'api',
    label: 'Google Gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    hint: 'aistudio.google.com/apikey — бесплатный tier (60 RPM, 1500 RPD). Список моделей загрузится автоматически после проверки ключа.',
  },
  {
    id: 'mistral-api',
    group: 'api',
    label: 'Mistral API',
    name: 'Mistral API',
    baseUrl: 'https://api.mistral.ai/v1',
  },
  {
    id: 'groq',
    group: 'api',
    label: 'Groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    hint: 'Ключ: console.groq.com → API Keys (бесплатный tier доступен)',
  },
  {
    id: 'together',
    group: 'api',
    label: 'Together AI',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
  },
  {
    id: 'openrouter',
    group: 'api',
    label: 'OpenRouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-r1',
    availableModels: [
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'meta-llama/llama-3.3-70b-instruct'
    ],
    hint: 'openrouter.ai — доступ к 100+ моделям через один ключ (например, DeepSeek R1, V3, Claude 3.5 Sonnet)',
  },
  // --- Бесплатно (серверные managed-сессии) ---
  // Сюда добавляются провайдеры, у которых токен/сессию хранит и
  // автоматически обновляет сам сервер. Клиент ничего не вводит —
  // выбирает пресет и сразу общается.
  {
    id: 'deepseek-managed',
    group: 'free',
    label: '✨ DeepSeek',
    name: 'DeepSeek (managed)',
    baseUrl: 'https://chat.deepseek.com/api/v0',
    model: 'deepseek_chat',
    apiKey: '__managed__',
    availableModels: ['deepseek_chat', 'deepseek_reasoner'],
    extraHeaders: {
      'Referer': 'https://chat.deepseek.com/',
      'Origin': 'https://chat.deepseek.com',
    },
    hint: 'Бесплатно. Токен и cookies хранятся на сервере и обновляются автоматически. Управление: /admin/deepseek или Telegram-бот.',
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
function SecretField({ label, hint, value, onChange, placeholder = 'sk-...' }) {
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
          placeholder={placeholder}
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
      className={`flex items-center gap-2 rounded-xl border p-3 transition-all duration-300
        ${active 
          ? 'border-emerald-400/40 bg-emerald-500/10 shadow-[0_0_15px_-5px_rgba(52,211,153,0.3)]' 
          : 'border-white/10 bg-graphite-900/40 hover:border-white/20 hover:bg-graphite-750'}`}
    >
      <button
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left group"
        title={active ? 'Активный ключ' : 'Сделать активным'}
      >
        <div
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-all duration-300
            ${active ? 'border-emerald-400 bg-emerald-400 scale-110' : 'border-cream-faint group-hover:border-cream-soft'}`}
        >
          {active && (
            <div className="h-2 w-2 rounded-full bg-graphite-950 shadow-inner" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className={`block truncate text-[14px] transition-colors ${active ? 'text-emerald-300 font-bold' : 'text-cream'}`}>
            {k.name || 'Без имени'}
          </span>
          <div className="mt-0.5 flex items-center gap-2 overflow-hidden">
            <span className="truncate text-[11px] text-cream-faint font-mono">
              {getSelectedModel(k) || 'модель не выбрана'}
            </span>
            {(k.maskedApiKey || k.apiKey) && (
              <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-cream-faint">
                {k.maskedApiKey || `${k.apiKey.slice(0, 4)}...${k.apiKey.slice(-4)}`}
              </span>
            )}
          </div>
        </div>
      </button>
      
      <div className="flex shrink-0 items-center gap-1 border-l border-white/5 pl-2 ml-1">
        <button
          onClick={onEdit}
          className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-cream-dim transition-all hover:bg-white/10 hover:text-cream"
        >
          Изменить
        </button>
        <button
          onClick={onDelete}
          className="grid h-8 w-8 place-items-center rounded-lg text-cream-faint transition-all hover:bg-red-500/20 hover:text-red-400"
          title="Удалить ключ"
        >
          <IconTrash />
        </button>
      </div>
    </div>
  )
}

function KeyEditor({ initial, onSave, onCancel, onValidate }) {
  const [form, setForm] = useState(initial)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState(null)
  const [advanced, setAdvanced] = useState(false)
  const modelRef = useRef(initial.model || '')

  const [onlyFree, setOnlyFree] = useState(Boolean(initial.onlyFree))

  const handleToggleOnlyFree = (val) => {
    setOnlyFree(val)
    setForm((f) => {
      const list = f.availableModels || []
      const filtered = val
        ? (f.id?.includes('groq') || f.baseUrl?.includes('groq.com')
            ? list
            : (f.id?.includes('openrouter') || f.baseUrl?.includes('openrouter')
                ? list.filter(m => m.includes(':free'))
                : (f.id?.includes('gemini') || f.baseUrl?.includes('googleapis')
                    ? list.filter(m => /flash|8b/i.test(m))
                    : list.filter(m => /free|mini|flash|haiku|lite|nano/i.test(m)))))
        : list
      const updatedModel = filtered.includes(f.model) ? f.model : (filtered[0] || '')
      return {
        ...f,
        onlyFree: val,
        model: updatedModel
      }
    })
  }

  const displayedModels = useMemo(() => {
    let list = form.availableModels || []
    if (onlyFree) {
      const providerId = form.id || ''
      if (providerId.includes('groq') || form.baseUrl?.includes('groq.com')) {
        return list
      }
      if (providerId.includes('gemini') || form.baseUrl?.includes('googleapis')) {
        list = list.filter(m => /flash|8b/i.test(m))
      } else if (providerId.includes('openrouter') || form.baseUrl?.includes('openrouter')) {
        list = list.filter(m => m.includes(':free'))
      } else {
        list = list.filter(m => /free|mini|flash|haiku|lite|nano/i.test(m))
      }
    }
    return list
  }, [form.availableModels, onlyFree, form.id, form.baseUrl])

  const inferName = (f) => {
    const preset = PROVIDER_PRESETS.find((p) => p.baseUrl === f.baseUrl)
    if (preset?.name) return preset.name
    try { return new URL(f.baseUrl).hostname.replace(/^www\./, '') }
    catch { return f.name || 'AI-провайдер' }
  }

  const prepareForSave = (f) => {
    let list = f.availableModels || []
    if (onlyFree) {
      const providerId = f.id || ''
      if (providerId.includes('groq') || f.baseUrl?.includes('groq.com')) {
        list = f.availableModels || []
      } else if (providerId.includes('gemini') || f.baseUrl?.includes('googleapis')) {
        list = list.filter(m => /flash|8b/i.test(m))
      } else if (providerId.includes('openrouter') || f.baseUrl?.includes('openrouter')) {
        list = list.filter(m => m.includes(':free'))
      } else {
        list = list.filter(m => /free|mini|flash|haiku|lite|nano/i.test(m))
      }
    }
    return {
      ...f,
      name: f.name?.trim() || inferName(f),
      onlyFree: onlyFree,
      model: f.model || list[0] || f.availableModels?.[0] || '',
    }
  }

  const set = (field) => (e) => {
    const value = e.target.value
    setForm((f) => {
      const next = { ...f, [field]: value }
      // При смене URL сбрасываем список моделей. При вводе токена модель из пресета сохраняем.
      if (field === 'baseUrl') {
        next.availableModels = []
        next.model = ''
      }
      return next
    })
    setResult(null)
  }

  const applyPreset = (preset) => {
    setForm((f) => ({
      ...f,
      name: preset.name || f.name,
      baseUrl: preset.baseUrl,
      // Pre-fill apiKey from the preset if it provides one (e.g. the
      // '__managed__' marker for server-side managed sessions). Otherwise
      // keep whatever the user had typed.
      apiKey: preset.apiKey !== undefined ? preset.apiKey : f.apiKey,
      availableModels: Array.isArray(preset.availableModels) ? preset.availableModels : [],
      model: preset.model || preset.availableModels?.[0] || '',
      authType: preset.authType || 'bearer',
      authHeader: preset.authHeader !== undefined ? preset.authHeader : f.authHeader,
      extraHeaders: preset.extraHeaders !== undefined ? preset.extraHeaders : (f.extraHeaders || {}),
    }))
    setResult(preset.hint ? { ok: true, message: preset.hint } : null)
  }

  const applyValidationResult = (r, sourceForm = form) => {
    const models = (r.ok && Array.isArray(r.models) && r.models.length > 0) ? r.models : []
    const preferredModel =
      (r.preferredModel && models.includes(r.preferredModel) && r.preferredModel) ||
      (models.length > 0 && models.includes(sourceForm.model) ? sourceForm.model : null) ||
      models[0] || sourceForm.model || ''

    const updatedForm = prepareForSave({
      ...sourceForm,
      availableModels: models.length > 0 ? models : (preferredModel ? [preferredModel] : []),
      model: preferredModel,
    })
    setForm(updatedForm)
  }

  const check = async () => {
    setChecking(true)
    setResult(null)
    try {
      const r = await onValidate({
        keyId: form.id,
        useStoredSecret: Boolean(form.hasSecret && !form.apiKey),
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
        authType: form.authType || 'bearer',
        authHeader: form.authHeader || '',
        extraHeaders: form.extraHeaders || {},
      })
      setResult(r)
      applyValidationResult(r)
    } finally {
      setChecking(false)
    }
  }

  const canSave =
    (form.apiKey.trim() || form.hasSecret) &&
    form.baseUrl.trim() &&
    (form.model.trim() || form.availableModels?.length > 0)

  useEffect(() => {
    modelRef.current = form.model || ''
  }, [form.model])

  const presetGroup = initial.baseUrl ? PROVIDER_PRESETS.find(p => p.baseUrl === initial.baseUrl)?.group || 'api' : 'api'
  const [activeTab, setActiveTab] = useState(presetGroup)
  
  const providerGroups = [
    { title: 'Official API', group: 'api',  cls: 'border-white/10 text-cream-soft hover:border-white/20 hover:bg-graphite-750 hover:text-cream' },
    { title: 'Free',       group: 'free', cls: 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300 hover:border-emerald-400/40 hover:bg-emerald-400/10' },
  ]

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-graphite-900/60 p-3">
      <div className="flex border-b border-white/10 text-[12px]">
        {providerGroups.map((group) => (
          <button
            key={group.group}
            type="button"
            onClick={() => setActiveTab(group.group)}
            className={`px-3 py-1.5 transition-colors border-b-2 ${activeTab === group.group ? 'border-cream text-cream' : 'border-transparent text-cream-faint hover:text-cream-soft'}`}
          >
            {group.title}
          </button>
        ))}
      </div>
      
      <div className="space-y-2">
        {providerGroups.filter(g => g.group === activeTab).map((group) => (
          <div key={group.group}>
            <div className="flex flex-wrap gap-1.5">
              {PROVIDER_PRESETS.filter((p) => p.group === group.group).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${group.cls}`}
                >
                  {preset.label}
                  {(() => {
                    const t = lookupProviderTier({ id: preset.id, baseUrl: preset.baseUrl })
                    return <span className={providerBadgeClass(t.tier)} title={(t.knownLimitations || []).join(' / ') || 'No known limitations'}>{providerBadgeText(t.tier)}</span>
                  })()}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {(form.apiKey === '__managed__' || form.apiKey === '__gateway__') ? (
        <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-3 py-2.5 text-[12px] text-emerald-200">
          🔒 Серверный режим — ключи и web-сессии хранятся на сервере.
          Ничего вводить не нужно, просто нажми <b>Сохранить</b>.
        </div>
      ) : (
        <SecretField
          label={form.authType === 'cookie' ? 'Cookie / сессия' : 'Токен / API-ключ'}
          hint={form.hasSecret && !form.apiKey ? 'Секрет уже сохранён на сервере. Оставь поле пустым, чтобы его не менять.' : 'Вставь ключ — модели подтянутся автоматически после проверки.'}
          value={form.apiKey}
          onChange={set('apiKey')}
          placeholder={form.hasSecret && !form.apiKey ? (form.maskedApiKey || 'секрет сохранён на сервере') : 'sk-...'}
        />
      )}

      {form.availableModels?.length > 0 ? (
        <>
          <div className="mb-2 mt-2 flex items-center justify-between">
            <label className="flex items-center gap-2 text-[12px] text-cream-soft cursor-pointer">
              <input
                type="checkbox"
                checked={onlyFree}
                onChange={(e) => handleToggleOnlyFree(e.target.checked)}
                className="rounded bg-graphite-900 border-white/10 text-cream focus:ring-0 focus:outline-none"
              />
              Показывать только бесплатные модели
            </label>
          </div>
          <Field label="Модель" hint={`Отображено моделей: ${displayedModels.length} из ${form.availableModels.length}`}>
            <select
              className={inputCls}
              value={form.model || displayedModels[0] || ''}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            >
              {displayedModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <div className="rounded-lg border border-white/5 bg-graphite-900/40 px-3 py-2 text-[12px] text-cream-faint">
          {checking
            ? 'Проверяю ключ и загружаю модели…'
            : form.model
              ? `Модель по умолчанию: ${form.model}`
              : 'Модели появятся автоматически после проверки ключа.'}
        </div>
      )}

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="w-full rounded-lg border border-white/10 px-3 py-1.5 text-left text-[12px] text-cream-faint transition-colors hover:bg-graphite-750 hover:text-cream-soft"
      >
        {advanced ? '▾' : '▸'} Дополнительно: URL, тип авторизации, заголовки
      </button>

      {advanced && (
        <div className="space-y-3 rounded-xl border border-white/5 bg-graphite-900/40 p-3">
          <Field label="Base URL">
            <input
              className={inputCls}
              value={form.baseUrl}
              onChange={set('baseUrl')}
              placeholder="https://api.openai.com/v1"
            />
          </Field>

          <Field label="Тип авторизации">
            <select
              className={inputCls}
              value={form.authType || 'bearer'}
              onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value }))}
            >
              <option value="bearer">Bearer Token</option>
              <option value="cookie">Cookie сессии</option>
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

          <Field label="Модель вручную" hint="Только если автозагрузка моделей не сработала">
            <input
              className={inputCls}
              value={form.model || ''}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="Оставь пустым для авто"
            />
          </Field>

          {(form.authType === 'cookie' || form.authType === 'custom') && (
            <Field
              label="Путь к ответу в JSON"
              hint='Обычно не нужен. Пример: choices.0.message.content'
            >
              <input
                className={inputCls}
                value={form.responsePath || ''}
                onChange={(e) => setForm((f) => ({ ...f, responsePath: e.target.value }))}
                placeholder="choices.0.message.content"
              />
            </Field>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-cream-soft">Дополнительные заголовки</span>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, extraHeaders: {} }))}
                className="rounded-lg border border-red-500/20 px-2 py-0.5 text-[11px] text-red-400/70 transition-colors hover:border-red-400/40 hover:text-red-300"
              >
                Очистить
              </button>
            </div>
            <textarea
              className={`${inputCls} resize-none font-mono text-[12px]`}
              rows={4}
              placeholder={"Cookie: name=value; name2=value2\nReferer: https://chat.deepseek.com/"}
              value={
                Object.entries(form.extraHeaders || {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')
              }
              onChange={(e) => {
                const parsed = {}
                for (const line of e.target.value.split('\n')) {
                  const idx = line.indexOf(':')
                  if (idx < 1) continue
                  const k = line.slice(0, idx).trim()
                  const v = line.slice(idx + 1).trim()
                  if (k && v) parsed[k] = v
                }
                setForm((f) => ({ ...f, extraHeaders: parsed }))
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'DeepSeek', headers: { 'Referer': 'https://chat.deepseek.com/', 'Origin': 'https://chat.deepseek.com', 'x-app-version': '20241129.1', 'x-client-platform': 'web', 'x-client-version': '1.0.0-always' } },
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
            </div>
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

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <button
          onClick={check}
          disabled={checking || !(form.apiKey.trim() || form.hasSecret) || !form.baseUrl.trim()}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
        >
          {checking ? 'Проверяю…' : 'Проверить'}
        </button>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
          >
            Отмена
          </button>
          <button
            onClick={() => canSave && onSave({ ...prepareForSave(form), keepExistingSecret: Boolean(form.hasSecret && !form.apiKey) })}
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

function RotateKeyPanel({ activeKey, onRotate }) {
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const rotate = async () => {
    if (!secret.trim()) return
    setBusy(true)
    setResult(null)
    try {
      const r = await onRotate({
        keyId: activeKey.id,
        apiKey: secret.trim(),
        baseUrl: activeKey.baseUrl,
        model: activeKey.model,
        authType: activeKey.authType || 'bearer',
      })
      setResult(r || { ok: false, message: 'Нет ответа сервера' })
      if (r?.ok) {
        setSecret('')
        // collapse shortly after success so the panel doesn't linger
        setTimeout(() => setOpen(false), 1800)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[13px] font-medium text-amber-200">
          🔑 Ротация ключа
          <span className="ml-2 text-[11px] font-normal text-amber-200/70">
            заменить секрет активного ключа
          </span>
        </span>
        <span className="text-amber-200/70 text-[12px]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] leading-snug text-amber-100/80">
            Введите <b>новый</b> ключ для «{activeKey.name || activeKey.id}». Сервер
            сначала проверит его реальным запросом к провайдеру, и только при успехе
            заменит старый секрет (старый перезаписывается = отзывается). Id ключа
            и текущие чаты не меняются.
          </p>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="новый ключ, напр. sk-..."
            autoComplete="off"
            className="w-full rounded-lg border border-white/10 bg-graphite-900/60 px-3 py-2 text-[13px] text-cream placeholder:text-cream-faint focus:border-amber-400/40 focus:outline-none"
          />
          {result && (
            <div
              className={`rounded-lg px-3 py-2 text-[12px] ${
                result.ok
                  ? 'border border-green-500/30 bg-green-500/10 text-green-300'
                  : 'border border-red-500/30 bg-red-500/10 text-red-300'
              }`}
            >
              {result.ok ? '✓ ' : '⚠ '}
              {result.message || (result.ok ? 'Ключ заменён.' : 'Не удалось заменить ключ.')}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => { setSecret(''); setResult(null); setOpen(false) }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
            >
              Отмена
            </button>
            <button
              onClick={rotate}
              disabled={busy || !secret.trim()}
              className="rounded-lg bg-amber-400 px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
            >
              {busy ? 'Проверяю и заменяю…' : 'Проверить и заменить'}
            </button>
          </div>
        </div>
      )}
    </div>
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
  onRotateKey,
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
  const isDevTools = devtoolsEnabled()

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
    <div className="fixed inset-0 z-50 flex items-stretch justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex h-[var(--app-height,100dvh)] w-full max-w-md flex-col overflow-hidden border-white/10 bg-graphite-800 shadow-2xl sm:h-auto sm:max-h-[min(90vh,var(--app-height,100dvh))] sm:rounded-2xl sm:border">
        <div className="flex shrink-0 items-center justify-between border-b border-white/5 px-4 pb-3 pt-safe sm:px-5 sm:py-3.5">
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

        <div className="mobile-scroll thin-scroll min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 pb-safe sm:max-h-[78vh] sm:px-5">
          {/* ---- Хранилище заблокировано: экран разблокировки ---- */}
          {vault.enabled && vault.locked ? (
            <UnlockScreen onUnlock={onVaultUnlock} />
          ) : (
          <>
          {/* ---- Менеджер ключей ---- */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-medium text-cream">API-ключи</h3>
              {!editing && (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
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

            {/* Step 10.8 — rotate the active key's secret in place. */}
            {active?.id && onRotateKey && (
              <RotateKeyPanel activeKey={active} onRotate={onRotateKey} />
            )}
          </section>

          {isDevTools && (
          <>
          {/* ---- Dev only: generation/debug parameters. Main product is automatic Agent Mode. ---- */}
          <section className="space-y-4 border-t border-white/5 pt-4">
            <h3 className="text-[13px] font-medium text-cream">
              Dev: параметры генерации
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
                className={`relative shrink-0 h-6 w-11 rounded-full transition-all duration-200 ${
                  settings.useWebAI ? 'bg-emerald-500' : 'bg-graphite-600 border border-white/10'
                }`}
              >
                <span
                  className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-lg transition-transform duration-200 ${
                    settings.useWebAI ? 'translate-x-[24px]' : 'translate-x-[2px]'
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
                className="w-full h-1.5 bg-graphite-700 rounded-lg appearance-none cursor-pointer accent-emerald-400"
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
                className={`relative shrink-0 h-6 w-11 rounded-full transition-all duration-200 ${
                  settings.stream ? 'bg-emerald-500' : 'bg-graphite-600 border border-white/10'
                }`}
              >
                <span
                  className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-lg transition-transform duration-200 ${
                    settings.stream ? 'translate-x-[24px]' : 'translate-x-[2px]'
                  }`}
                />
              </button>
            </label>
          </section>
          </>
          )}

          {/* ---- Dev Lab only: approval policy + MCP. Main BrowserAI is now
              automatic Agent Mode; regular users should not see manual agent
              plumbing in Settings. */}
          {isDevTools && <AgentSettingsSection />}

          {/* ---- Администрирование (только для владельца/dev) ---- */}
          <section className="space-y-3 border-t border-white/5 pt-4">
            <h3 className="text-[13px] font-medium text-cream">
              🛠️ Администрирование
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <a
                href="/admin/deepseek"
                target="_blank"
                className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-graphite-900/40 p-3 text-center transition-colors hover:bg-graphite-750 hover:text-cream"
              >
                <span className="text-[18px] mb-1">🐳</span>
                <span className="text-[11px] text-cream-soft">DeepSeek Session</span>
              </a>
              <a
                href="/admin/ops"
                target="_blank"
                className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-graphite-900/40 p-3 text-center transition-colors hover:bg-graphite-750 hover:text-cream"
              >
                <span className="text-[18px] mb-1">⚙️</span>
                <span className="text-[11px] text-cream-soft">Server Ops</span>
              </a>
              <a
                href="/admin/agent"
                target="_blank"
                className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-graphite-900/40 p-3 text-center transition-colors hover:bg-graphite-750 hover:text-cream"
              >
                <span className="text-[18px] mb-1">🤖</span>
                <span className="text-[11px] text-cream-soft">Agent Status</span>
              </a>
              <button
                onClick={() => {
                   localStorage.setItem('browserai.devtools', localStorage.getItem('browserai.devtools') === '1' ? '0' : '1');
                   window.location.reload();
                }}
                className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-graphite-900/40 p-3 text-center transition-colors hover:bg-graphite-750 hover:text-cream"
              >
                <span className="text-[18px] mb-1">🧪</span>
                <span className="text-[11px] text-cream-soft">
                  {isDevTools ? 'Disable Dev Mode' : 'Enable Dev Mode'}
                </span>
              </button>
            </div>
          </section>

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
          </>
          )}
        </div>

        <div className="flex justify-end border-t border-white/5 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-lg bg-emerald-500 px-6 py-2 text-[13px] font-semibold text-white shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-400 hover:scale-[1.02] active:scale-95"
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}
