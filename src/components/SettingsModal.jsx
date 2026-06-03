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
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
  },
  {
    id: 'deepseek-api',
    label: 'DeepSeek API',
    name: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    authType: 'bearer',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authType: 'bearer',
  },
  // --- Сессионные токены (веб-интерфейс) ---
  {
    id: 'deepseek-web',
    label: '🍪 DeepSeek Web',
    name: 'DeepSeek Web (сессия)',
    baseUrl: 'https://chat.deepseek.com/api/v0',
    model: 'deepseek_chat',
    authType: 'bearer',
    hint: 'F12 → Network → запрос к /chat/completion → заголовок Authorization',
  },
  {
    id: 'grok-web',
    label: '🍪 Grok Web',
    name: 'Grok Web (сессия)',
    baseUrl: 'https://grok.com/api',
    model: 'grok-3',
    authType: 'bearer',
    hint: 'F12 → Network → запрос к /chat → заголовок Authorization',
  },
  {
    id: 'claude-web',
    label: '🍪 Claude Web',
    name: 'Claude Web (сессия)',
    baseUrl: 'https://claude.ai/api',
    model: 'claude-3-5-sonnet-20241022',
    authType: 'custom',
    authHeader: 'Cookie',
    hint: 'F12 → Network → любой запрос к /api → скопируй весь заголовок Cookie',
  },
  {
    id: 'custom-web',
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
      if (field === 'baseUrl' || field === 'apiKey') {
        next.availableModels = []
        next.model = ''
        // authType НЕ сбрасываем — пользователь мог специально выбрать cookie
      }
      return next
    })
    setResult(null)
  }

  const applyPreset = (preset) => {
    setForm((f) => ({
      ...f,
      name: f.name || preset.name,
      baseUrl: preset.baseUrl,
      availableModels: [],
      model: preset.model || '',
      authType: preset.authType || 'bearer',
      authHeader: preset.authHeader || '',
    }))
    setResult(null)
    if (preset.hint) alert(`💡 Как получить токен:\n\n${preset.hint}`)
  }

  const check = async () => {
    setChecking(true)
    setResult(null)
    try {
      const r = await onValidate({
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
      })
      setResult(r)
      if (r.ok && Array.isArray(r.models) && r.models.length > 0) {
        setForm((f) => ({
          ...f,
          availableModels: r.models,
          model:
            (r.preferredModel && r.models.includes(r.preferredModel) && r.preferredModel) ||
            (r.models.includes(f.model) ? f.model : r.models[0]),
        }))
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

  useEffect(() => {
    const hasCredentials = form.baseUrl.trim() && form.apiKey.trim()
    if (!hasCredentials) return undefined

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setChecking(true)
      try {
        const r = await onValidate(
          {
            baseUrl: form.baseUrl,
            apiKey: form.apiKey,
            model: modelRef.current,
          },
          controller.signal,
        )
        if (controller.signal.aborted) return
        setResult(r)
        if (r.ok && Array.isArray(r.models) && r.models.length > 0) {
          setForm((f) => ({
            ...f,
            availableModels: r.models,
            model:
              (r.preferredModel && r.models.includes(r.preferredModel) && r.preferredModel) ||
              (r.models.includes(f.model) ? f.model : r.models[0]),
          }))
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
  }, [form.baseUrl, form.apiKey, onValidate])

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-graphite-900/60 p-3">
      <div>
        <div className="mb-2 text-[12px] text-cream-faint">Официальные API</div>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_PRESETS.filter((p) => !p.id.endsWith('-web')).map((preset) => (
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
          {PROVIDER_PRESETS.filter((p) => p.id.endsWith('-web')).map((preset) => (
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
            className="rounded-lg px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750"
          >
            Отмена
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={!canSave}
            className="rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
          >
            Сохранить ключ
          </button>
        </div>
      </div>
    </div>
  )
}

// Экран разблокировки (когда хранилище зашифровано и закрыто)
function UnlockScreen({ onUnlock }) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await onUnlock(pass)
    } catch (e) {
      setErr(e.message || 'Не удалось разблокировать')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
      <div className="flex items-center gap-2 text-[13px] text-cream">
        <IconLock /> Хранилище ключей зашифровано
      </div>
      <p className="text-[12px] text-cream-faint">
        Введите мастер-пароль, чтобы расшифровать API-ключи.
      </p>
      <input
        className={inputCls}
        type="password"
        value={pass}
        onChange={(e) => {
          setPass(e.target.value)
          setErr('')
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Мастер-пароль"
        autoFocus
      />
      {err && <div className="text-[12px] text-red-300">⚠ {err}</div>}
      <button
        onClick={submit}
        disabled={busy || !pass}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-cream px-4 py-2 text-[13px] font-medium text-graphite-900 transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-40"
      >
        <IconUnlock /> {busy ? 'Разблокировка…' : 'Разблокировать'}
      </button>
    </div>
  )
}

// Секция управления шифрованием
function VaultSection({
  vault,
  onSetup,
  onLock,
  onChange,
  onDisable,
  onAutolock,
  onBackup,
  onRestore,
}) {
  const [mode, setMode] = useState(null) // null | 'setup' | 'change'
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState(null)
  const restoreRef = useRef(null)

  const reset = () => {
    setMode(null)
    setPass('')
    setPass2('')
    setErr('')
  }

  const handleRestore = async (file) => {
    if (!file) return
    setRestoreMsg(null)
    try {
      const text = await file.text()
      const backup = JSON.parse(text)
      if (backup.type !== 'browserai-backup')
        throw new Error('Это не файл бэкапа BrowserAI')
      if (
        !confirm(
          'Восстановить из бэкапа? Текущие ключи и параметры будут заменены.',
        )
      )
        return
      await onRestore(backup)
      setRestoreMsg({
        ok: true,
        text: backup.encrypted
          ? 'Восстановлено. Введите мастер-пароль для разблокировки.'
          : 'Бэкап восстановлен.',
      })
    } catch (e) {
      setRestoreMsg({ ok: false, text: e.message || 'Ошибка восстановления' })
    }
  }

  const submit = async () => {
    if (pass.length < 4) return setErr('Минимум 4 символа')
    if (pass !== pass2) return setErr('Пароли не совпадают')
    setBusy(true)
    setErr('')
    try {
      if (mode === 'setup') await onSetup(pass)
      else await onChange(pass)
      reset()
    } catch (e) {
      setErr(e.message || 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  const btn =
    'rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream'

  return (
    <section className="space-y-2 border-t border-white/5 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[13px] font-medium text-cream">
          {vault.enabled ? <IconLock /> : <IconUnlock />} Шифрование ключей
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] ${
            vault.enabled
              ? 'bg-green-500/15 text-green-300'
              : 'bg-graphite-700 text-cream-faint'
          }`}
        >
          {vault.enabled ? 'включено' : 'выключено'}
        </span>
      </div>

      {!mode && (
        <>
          <p className="text-[11px] text-cream-faint">
            {vault.enabled
              ? 'Ключи в БД зашифрованы мастер-паролем (AES-256-GCM). При перезапуске сервера потребуется разблокировка.'
              : 'Включите, чтобы хранить API-ключи в БД в зашифрованном виде под мастер-паролем.'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {!vault.enabled ? (
              <button onClick={() => setMode('setup')} className={btn}>
                Включить шифрование
              </button>
            ) : (
              <>
                <button onClick={() => setMode('change')} className={btn}>
                  Сменить пароль
                </button>
                <button onClick={onLock} className={btn}>
                  Заблокировать сейчас
                </button>
                <button
                  onClick={() => {
                    if (
                      confirm(
                        'Отключить шифрование? Ключи будут расшифрованы и сохранены в БД в открытом виде.',
                      )
                    )
                      onDisable()
                  }}
                  className="rounded-lg border border-red-500/20 px-2.5 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-500/10"
                >
                  Отключить
                </button>
              </>
            )}
          </div>

          {/* Автоблокировка по бездействию (только когда включено) */}
          {vault.enabled && (
            <label className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[12px] text-cream-soft">
                Автоблокировка при бездействии
              </span>
              <select
                value={vault.autoLockMinutes ?? 0}
                onChange={(e) => onAutolock(parseInt(e.target.value, 10))}
                className="rounded-lg border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream focus:border-cream/30 focus:outline-none"
              >
                <option value={0}>Выключена</option>
                <option value={5}>5 минут</option>
                <option value={15}>15 минут</option>
                <option value={30}>30 минут</option>
                <option value={60}>1 час</option>
              </select>
            </label>
          )}

          {/* Зашифрованный бэкап БД */}
          <div className="mt-2 border-t border-white/5 pt-2">
            <div className="mb-1 text-[11px] text-cream-faint">
              Бэкап базы данных (ключи + параметры
              {vault.enabled ? ', в зашифрованном виде' : ''})
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={onBackup} className={btn}>
                <span className="inline-flex items-center gap-1">
                  <IconDownload /> Экспорт бэкапа
                </span>
              </button>
              <button onClick={() => restoreRef.current?.click()} className={btn}>
                <span className="inline-flex items-center gap-1">
                  <IconUpload /> Восстановить бэкап
                </span>
              </button>
              <input
                ref={restoreRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  handleRestore(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
            {restoreMsg && (
              <div
                className={`mt-2 rounded-lg px-3 py-2 text-[12px] ${
                  restoreMsg.ok
                    ? 'border border-green-500/30 bg-green-500/10 text-green-300'
                    : 'border border-red-500/30 bg-red-500/10 text-red-300'
                }`}
              >
                {restoreMsg.text}
              </div>
            )}
          </div>
        </>
      )}

      {mode && (
        <div className="space-y-2 rounded-xl border border-white/10 bg-graphite-900/60 p-3">
          <input
            className={inputCls}
            type="password"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value)
              setErr('')
            }}
            placeholder={mode === 'setup' ? 'Новый мастер-пароль' : 'Новый пароль'}
            autoFocus
          />
          <input
            className={inputCls}
            type="password"
            value={pass2}
            onChange={(e) => {
              setPass2(e.target.value)
              setErr('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Повторите пароль"
          />
          {err && <div className="text-[12px] text-red-300">⚠ {err}</div>}
          <p className="text-[11px] text-cream-faint">
            ⚠️ Пароль нельзя восстановить — забыв его, вы потеряете доступ к
            ключам.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={reset} className={btn}>
              Отмена
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-40"
            >
              {busy ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export default function SettingsModal({
  open,
  settings,
  online,
  vault = { enabled: false, locked: false },
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
