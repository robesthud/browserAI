import { useEffect, useMemo, useState } from 'react'
import { IconEye, IconEyeOff } from '../icons.jsx'
import { backend } from '../lib/backend.js'

const SETTINGS_KEY = 'browserai.settings.v2'
const CHATS_KEY = 'browserai.chats.v1'
const AUTH_FLAG = 'browserai.auth.enabled'

export function mergeChats(localChats = [], cloudChats = []) {
  const map = new Map()
  const norm = (c) => ({
    ...c,
    id: String(c.id || ''),
    updatedAt: Number(c.updatedAt || c.updated_at || 0),
    createdAt: Number(c.createdAt || c.created_at || Date.now()),
    messages: Array.isArray(c.messages) ? c.messages : [],
  })
  for (const raw of localChats) {
    const c = norm(raw)
    if (!c.id) continue
    map.set(c.id, c)
  }
  for (const raw of cloudChats) {
    const c = norm(raw)
    if (!c.id) continue
    const prev = map.get(c.id)
    if (!prev) {
      map.set(c.id, c)
      continue
    }
    // берём более свежий по updatedAt, при равенстве — с большим кол-вом сообщений
    const prevScore = (prev.updatedAt || 0) * 1000 + (prev.messages?.length || 0)
    const nextScore = (c.updatedAt || 0) * 1000 + (c.messages?.length || 0)
    if (nextScore >= prevScore) {
      // cloud новее — мержим сообщения, избегая дублей по id
      const mergedMessages = [...(prev.messages || [])]
      const seen = new Set(mergedMessages.map(m => m.id))
      for (const m of c.messages || []) {
        if (m?.id && !seen.has(m.id)) {
          mergedMessages.push(m)
          seen.add(m.id)
        }
      }
      map.set(c.id, { ...prev, ...c, messages: mergedMessages.length ? mergedMessages : c.messages })
    }
    // иначе оставляем локальную версию — она новее
  }
  return Array.from(map.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

function writeCloudToLocal(data, opts = {}) {
  if (!data) return { merged: false }
  const { merge = true, source = 'cloud' } = opts
  let mergedChats = null
  let mergedSettings = null

  // Восстанавливаем настройки пользователя
  if (data.settings) {
    try {
      const existing = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
      mergedSettings = {
        ...existing,
        ...data.settings,
        keys: existing.keys?.length > 0 ? existing.keys : (data.settings.keys || []),
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(mergedSettings))
    } catch {
      mergedSettings = data.settings
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings))
    }
  }

  // Восстанавливаем историю чатов — с merge, чтобы не терять локальные черновики
  if (Array.isArray(data.chats)) {
    try {
      const localRaw = localStorage.getItem(CHATS_KEY)
      const localChats = localRaw ? JSON.parse(localRaw) : []
      if (merge && localChats.length) {
        mergedChats = mergeChats(localChats, data.chats)
        localStorage.setItem(CHATS_KEY, JSON.stringify(mergedChats))
        // debug trace
        try { console.log(`[BrowserAI cloud sync] merge: local ${localChats.length} + cloud ${data.chats.length} → ${mergedChats.length}  source=${source}`) } catch {}
      } else {
        mergedChats = data.chats
        localStorage.setItem(CHATS_KEY, JSON.stringify(data.chats))
      }
    } catch {
      mergedChats = data.chats
      localStorage.setItem(CHATS_KEY, JSON.stringify(data.chats))
    }
  }

  return { merged: true, chats: mergedChats, settings: mergedSettings }
}

// экспорт для useChats / тестов
export { writeCloudToLocal }
export const __cloudSyncInternals = { mergeChats, CHATS_KEY, SETTINGS_KEY }

const inputCls = 'w-full rounded-xl border border-white/10 bg-graphite-900 px-4 py-3 text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none'
const passwordInputCls = `${inputCls} pr-12`

function PasswordField({
  value,
  onChange,
  placeholder,
  visible,
  onToggle,
  required = false,
  minLength,
  autoComplete = 'current-password',
}) {
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        className={passwordInputCls}
      />
      <button
        type="button"
        onClick={onToggle}
        className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-cream-faint transition-colors hover:bg-graphite-800 hover:text-cream"
        title={visible ? 'Скрыть пароль' : 'Показать пароль'}
        aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
      >
        {visible ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  )
}

function AuthPanel({ onAuthenticated }) {
  const resetToken = useMemo(() => new URLSearchParams(window.location.search).get('reset_token') || '', [])
  // режимы: login | register | forgot | reset | sms-phone | sms-code | sms-reset
  const [mode, setMode] = useState(resetToken ? 'reset' : 'login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [smsResetToken, setSmsResetToken] = useState('')
  const [registrationSecret, setRegistrationSecret] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showPassword2, setShowPassword2] = useState(false)
  const [showRegistrationSecret, setShowRegistrationSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const clearStatus = () => {
    setError('')
    setMessage('')
  }

  const switchMode = (nextMode) => {
    clearStatus()
    setMode(nextMode)
  }

  const resetPasswordVisibility = () => {
    setShowPassword(false)
    setShowPassword2(false)
    setShowRegistrationSecret(false)
  }

  const finishResetToLogin = (nextMessage) => {
    setMessage(nextMessage)
    window.history.replaceState({}, '', window.location.pathname)
    setMode('login')
    setPassword('')
    setPassword2('')
    setSmsCode('')
    setSmsResetToken('')
    resetPasswordVisibility()
  }

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    clearStatus()
    try {
      if (mode === 'login') {
        await backend.authLogin({ email, password })
        await onAuthenticated()
        return
      }

      if (mode === 'register') {
        if (password !== password2) {
          setError('Пароли не совпадают')
          return
        }
        await backend.authRegister({ email, name, phone, password, registrationSecret })
        await onAuthenticated()
        return
      }

      if (mode === 'forgot') {
        await backend.authForgotPassword(email)
        setMessage('Если email зарегистрирован, ссылка восстановления отправлена.')
        return
      }

      if (mode === 'reset') {
        if (password !== password2) {
          setError('Пароли не совпадают')
          return
        }
        await backend.authResetPassword(resetToken, password)
        finishResetToLogin('Пароль изменён. Теперь войдите.')
        return
      }

      // SMS-восстановление: шаг 1 — ввод телефона
      if (mode === 'sms-phone') {
        await backend.authSmsSend(phone)
        setMessage('Код отправлен на ваш номер')
        setMode('sms-code')
        return
      }

      // SMS-восстановление: шаг 2 — ввод кода
      if (mode === 'sms-code') {
        const data = await backend.authSmsVerify(phone, smsCode)
        setSmsResetToken(data.resetToken)
        setMessage('Код подтверждён! Введите новый пароль.')
        setMode('sms-reset')
        return
      }

      // SMS-восстановление: шаг 3 — новый пароль
      if (mode === 'sms-reset') {
        if (password !== password2) {
          setError('Пароли не совпадают')
          return
        }
        await backend.authResetPassword(smsResetToken, password)
        finishResetToLogin('Пароль изменён! Теперь войдите.')
        return
      }
    } catch (e) {
      setError(e.message || 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  const title = {
    login: 'Войти',
    register: 'Регистрация',
    forgot: 'Сброс по email',
    reset: 'Новый пароль',
    'sms-phone': 'Сброс по SMS',
    'sms-code': 'Введите код',
    'sms-reset': 'Новый пароль',
  }[mode] || 'BrowserAI'

  const description = {
    login: 'Войдите в свой аккаунт, чтобы открыть чаты, ключи и workspace.',
    register: 'Первый пользователь станет владельцем аккаунта. Телефон нужен для сброса по SMS.',
    forgot: 'Введите email, и мы отправим ссылку для восстановления пароля.',
    reset: 'Придумайте новый пароль и подтвердите его.',
    'sms-phone': 'Укажите номер телефона, привязанный к аккаунту.',
    'sms-code': 'Введите 6-значный код, который пришёл в SMS.',
    'sms-reset': 'Задайте новый пароль для входа в аккаунт.',
  }[mode]

  const btnLabel = busy ? 'Подождите…' : {
    login: 'Войти',
    register: 'Зарегистрироваться',
    forgot: 'Отправить ссылку на email',
    reset: 'Сменить пароль',
    'sms-phone': 'Получить SMS-код',
    'sms-code': 'Подтвердить код',
    'sms-reset': 'Сменить пароль',
  }[mode]

  const showPasswordRequirements = ['register', 'reset', 'sms-reset'].includes(mode)

  return (
    <div className="flex min-h-screen items-center justify-center bg-graphite-900 px-4 py-8 text-cream">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-graphite-800 p-6 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-3xl font-semibold">BrowserAI</div>
          <div className="mt-1 text-[13px] text-cream-faint">{title}</div>
          {description && (
            <div className="mt-3 text-sm leading-6 text-cream-dim">
              {description}
            </div>
          )}
        </div>

        <form onSubmit={submit} className="space-y-3">
          {/* Имя */}
          {mode === 'register' && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Имя"
              className={inputCls}
            />
          )}

          {/* Email */}
          {['login', 'register', 'forgot'].includes(mode) && (
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              className={inputCls}
            />
          )}

          {/* Телефон при регистрации */}
          {mode === 'register' && (
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Телефон +7... (для сброса пароля по SMS)"
              className={inputCls}
            />
          )}

          {/* Телефон при SMS-сбросе */}
          {mode === 'sms-phone' && (
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Номер телефона +7..."
              required
              className={inputCls}
            />
          )}

          {/* SMS-код */}
          {mode === 'sms-code' && (
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={smsCode}
              onChange={(e) => setSmsCode(e.target.value)}
              placeholder="6-значный код из SMS"
              required
              className={inputCls}
            />
          )}

          {/* Пароль */}
          {['login', 'register', 'reset', 'sms-reset'].includes(mode) && (
            <PasswordField
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'login' ? 'Пароль' : 'Новый пароль'}
              required
              minLength={10}
              visible={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          )}

          {/* Подтверждение пароля */}
          {['register', 'reset', 'sms-reset'].includes(mode) && (
            <PasswordField
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="Повторите пароль"
              required
              minLength={10}
              visible={showPassword2}
              onToggle={() => setShowPassword2((v) => !v)}
              autoComplete="new-password"
            />
          )}

          {/* Секрет регистрации */}
          {mode === 'register' && (
            <PasswordField
              value={registrationSecret}
              onChange={(e) => setRegistrationSecret(e.target.value)}
              placeholder="Секрет регистрации (если не первый пользователь)"
              visible={showRegistrationSecret}
              onToggle={() => setShowRegistrationSecret((v) => !v)}
              autoComplete="off"
            />
          )}

          {showPasswordRequirements && (
            <div className="rounded-xl border border-white/10 bg-graphite-900/70 px-3 py-2 text-[12px] leading-5 text-cream-faint">
              Пароль должен содержать минимум 10 символов, заглавную и строчную буквы, цифру и спецсимвол.
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              {message}
            </div>
          )}

          <button
            disabled={busy}
            className="w-full rounded-xl bg-cream px-4 py-3 font-medium text-graphite-900 transition-opacity disabled:opacity-60"
          >
            {btnLabel}
          </button>
        </form>

        {/* Навигация между режимами */}
        <div className="mt-5 flex flex-wrap justify-center gap-3 text-sm text-cream-dim">
          {mode !== 'login' && (
            <button
              onClick={() => switchMode('login')}
              className="hover:text-cream"
            >
              Войти
            </button>
          )}
          {mode !== 'register' && (
            <button
              onClick={() => switchMode('register')}
              className="hover:text-cream"
            >
              Регистрация
            </button>
          )}
          {!['forgot', 'sms-phone', 'sms-code', 'sms-reset', 'reset'].includes(mode) && (
            <>
              <button
                onClick={() => switchMode('forgot')}
                className="hover:text-cream"
              >
                Сброс по email
              </button>
              <button
                onClick={() => switchMode('sms-phone')}
                className="hover:text-cream"
              >
                Сброс по SMS
              </button>
            </>
          )}
          {['forgot', 'sms-phone', 'sms-code', 'sms-reset'].includes(mode) && mode !== 'sms-code' && (
            <button
              onClick={() => switchMode('login')}
              className="hover:text-cream"
            >
              ← Назад
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AuthGate({ children }) {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState(null)
  const [renderKey, setRenderKey] = useState(0)

  const loadSession = async () => {
    setLoading(true)
    try {
      const me = await backend.authMe()
      if (me.user) {
        localStorage.setItem(AUTH_FLAG, '1')
        const cloud = await backend.getCloud().catch(() => null)
        // backend.getCloud() returns the JSON payload directly, not { data }.
        // Older code read cloud.data and silently skipped restoring chats,
        // so OpenHands conversations imported by /api/cloud never appeared in UI.
        writeCloudToLocal(cloud?.data ?? cloud)
        setUser(me.user)
        setRenderKey((v) => v + 1)
      } else {
        localStorage.removeItem(AUTH_FLAG)
        setUser(null)
      }
    } catch {
      localStorage.removeItem(AUTH_FLAG)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSession()
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-graphite-900 text-cream">
        <div className="text-sm text-cream-dim">Загрузка BrowserAI…</div>
      </div>
    )
  }

  if (!user) return <AuthPanel onAuthenticated={loadSession} />

  return children({ user, reloadAuth: loadSession, renderKey })
}
