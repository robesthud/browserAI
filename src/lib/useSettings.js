// Хук настроек: ключи + параметры генерации.
// Источник истины — серверная БД (Express + SQLite). Если бэкенд недоступен —
// прозрачный fallback на localStorage. Зеркалируем в localStorage всегда.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  getActiveKey,
  loadSettings,
  normalizeKey,
  saveSettings,
} from './settings.js'
import { backend, ping } from './backend.js'
import { validateKey as clientValidate } from './api.js'

function fromServer(data) {
  return {
    keys: (data.keys || []).map(normalizeKey),
    activeKeyId: data.activeKeyId ?? null,
    systemPrompt: data.params?.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
    temperature: data.params?.temperature ?? DEFAULT_SETTINGS.temperature,
    stream: data.params?.stream ?? DEFAULT_SETTINGS.stream,
    useWebAI: data.params?.useWebAI ?? DEFAULT_SETTINGS.useWebAI,
  }
}

function sameModels(a = [], b = []) {
  if (a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}

export function useSettings() {
  const [settings, setSettings] = useState(() => loadSettings())
  const [online, setOnline] = useState(false)
  const [vault, setVault] = useState({ enabled: false, locked: false })
  const onlineRef = useRef(false)
  const autoRefreshRef = useRef('')
  // cloudAuth=true означает что пользователь залогинен через аккаунт
  const cloudAuth = typeof localStorage !== 'undefined' && localStorage.getItem('browserai.auth.enabled') === '1'

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      const ok = await ping()
      if (cancelled) return
      onlineRef.current = ok
      setOnline(ok)

      if (!ok) return

      try {
        const data = await backend.getSettings()
        if (cancelled) return

        if (data.vault) setVault(data.vault)
        let next = fromServer(data)

        const local = loadSettings()
        const locked = data.vault?.enabled && data.vault?.locked

        // Если залогинен через аккаунт — данные уже загружены в AuthGate через /api/cloud
        // Нам нужно только подгрузить ключи/vault с сервера (они не идут через cloud)
        if (cloudAuth) {
          // Ключи всегда берём с сервера когда залогинен
          if (!locked && next.keys.length === 0 && local.keys.length > 0) {
            // Перенос локальных ключей на сервер при первом входе
            await backend.importKeys(local.keys, local.activeKeyId)
            await backend.setParams({
              systemPrompt: local.systemPrompt,
              temperature: local.temperature,
              stream: local.stream,
              useWebAI: local.useWebAI,
            })
            const refreshed = await backend.getSettings()
            next = fromServer(refreshed)
          }
          setSettings((prev) => ({
            ...prev,
            keys: next.keys.length > 0 ? next.keys : prev.keys,
            activeKeyId: next.activeKeyId ?? prev.activeKeyId,
          }))
          return
        }

        // Не залогинен — стандартная синхронизация через /api/settings
        if (!locked && next.keys.length === 0 && local.keys.length > 0) {
          await backend.importKeys(local.keys, local.activeKeyId)
          await backend.setParams({
            systemPrompt: local.systemPrompt,
            temperature: local.temperature,
            stream: local.stream,
            useWebAI: local.useWebAI,
          })
          const refreshed = await backend.getSettings()
          next = fromServer(refreshed)
        }

        setSettings(next)
        if (!locked) saveSettings(next)
      } catch {
        /* остаёмся на localStorage */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [cloudAuth])

  useEffect(() => {
    if (vault.enabled && !cloudAuth) return
    saveSettings(settings)
  }, [settings, vault.enabled, cloudAuth])

  const refresh = useCallback(async () => {
    if (!onlineRef.current) return
    try {
      const data = await backend.getSettings()
      if (data.vault) setVault(data.vault)
      const next = fromServer(data)
      if (cloudAuth) {
        setSettings((prev) => ({
          ...prev,
          keys: next.keys.length > 0 ? next.keys : prev.keys,
          activeKeyId: next.activeKeyId ?? prev.activeKeyId,
        }))
      } else {
        setSettings(next)
      }
    } catch {
      /* ignore */
    }
  }, [cloudAuth])

  const vaultSetup = useCallback(async (passphrase) => {
    const data = await backend.vaultSetup(passphrase)
    setVault(data)
    setSettings((s) => ({
      ...s,
      keys: (data.keys || []).map(normalizeKey),
      activeKeyId: data.activeKeyId,
    }))
  }, [])

  const vaultUnlock = useCallback(async (passphrase) => {
    const data = await backend.vaultUnlock(passphrase)
    setVault(data)
    setSettings((s) => ({
      ...s,
      keys: (data.keys || []).map(normalizeKey),
      activeKeyId: data.activeKeyId,
    }))
  }, [])

  const vaultLock = useCallback(async () => {
    const data = await backend.vaultLock()
    setVault(data)
    setSettings((s) => ({
      ...s,
      keys: s.keys.map((k) => ({ ...k, apiKey: '', locked: true })),
    }))
  }, [])

  const vaultChange = useCallback(async (passphrase) => {
    await backend.vaultChange(passphrase)
    await refresh()
  }, [refresh])

  const vaultDisable = useCallback(async () => {
    const data = await backend.vaultDisable()
    setVault(data)
    if (data.keys) {
      setSettings((s) => ({
        ...s,
        keys: data.keys.map(normalizeKey),
        activeKeyId: data.activeKeyId,
      }))
    }
  }, [])

  const vaultAutolock = useCallback(async (minutes) => {
    const data = await backend.vaultAutolock(minutes)
    setVault(data)
  }, [])

  const vaultBackup = useCallback(async () => {
    const data = await backend.vaultBackup()
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `browserai-backup-${stamp}.json`
    document.body.appendChild(a)
    // Android WebView: a.click() с download не работает → window.location
    if (/Android/i.test(navigator.userAgent) && !/Chrome\/[7-9]\d|Chrome\/1\d\d/i.test(navigator.userAgent)) {
      window.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } else {
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  }, [])

  const vaultRestore = useCallback(async (backup) => {
    const data = await backend.vaultRestore(backup)
    setVault(data)
    setSettings((s) => ({
      ...s,
      keys: (data.keys ?? s.keys).map(normalizeKey),
      activeKeyId: data.activeKeyId ?? s.activeKeyId,
      systemPrompt: data.params?.systemPrompt ?? s.systemPrompt,
      temperature: data.params?.temperature ?? s.temperature,
      stream: data.params?.stream ?? s.stream,
      useWebAI: data.params?.useWebAI ?? s.useWebAI,
    }))
  }, [])

  useEffect(() => {
    if (!online || !vault.enabled) return

    const id = setInterval(async () => {
      try {
        const st = await backend.vaultStatus()
        setVault(st)
        if (st.locked) {
          setSettings((s) => ({
            ...s,
            keys: s.keys.map((k) =>
              k.encrypted ? { ...k, apiKey: '', locked: true } : k,
            ),
          }))
        }
      } catch {
        /* ignore */
      }
    }, 60 * 1000)

    return () => clearInterval(id)
  }, [online, vault.enabled])

  const validateKey = useCallback(async (key, signal) => {
    if (onlineRef.current) {
      try {
        return await backend.validate(key, signal)
      } catch {
        /* fallthrough */
      }
    }
    return clientValidate(key, signal)
  }, [])

  const refreshModelsForKey = useCallback(
    async (key) => {
      if (!key?.baseUrl || !key?.apiKey) return

      try {
        const result = await validateKey(key)
        if (!result?.ok) return

        const normalized = normalizeKey({
          ...key,
          availableModels:
            Array.isArray(result.models) && result.models.length > 0
              ? result.models
              : key.availableModels || [],
          model:
            result.preferredModel ||
            key.model ||
            result.models?.[0] ||
            key.availableModels?.[0] ||
            '',
        })

        if (
          normalized.model === key.model &&
          sameModels(normalized.availableModels, key.availableModels || [])
        ) {
          return
        }

        if (onlineRef.current) {
          try {
            const data = await backend.saveKey(normalized)
            setSettings((s) => ({
              ...s,
              keys: (data.keys || []).map(normalizeKey),
              activeKeyId: data.activeKeyId,
            }))
            return
          } catch {
            /* fallthrough */
          }
        }

        setSettings((s) => ({
          ...s,
          keys: s.keys.map((k) =>
            k.id === normalized.id ? normalizeKey({ ...k, ...normalized }) : k,
          ),
        }))
      } catch {
        /* ignore */
      }
    },
    [validateKey],
  )

  const saveKey = useCallback(async (key) => {
    const normalized = normalizeKey(key)

    if (onlineRef.current) {
      try {
        const data = await backend.saveKey(normalized)
        setSettings((s) => ({
          ...s,
          keys: (data.keys || []).map(normalizeKey),
          activeKeyId: data.activeKeyId,
        }))
        return
      } catch {
        /* fallthrough */
      }
    }

    setSettings((s) => {
      const exists = s.keys.some((k) => k.id === normalized.id)
      const keys = exists
        ? s.keys.map((k) =>
            k.id === normalized.id ? normalizeKey({ ...k, ...normalized }) : k,
          )
        : [...s.keys, normalized]
      const activeKeyId = s.activeKeyId ?? normalized.id
      return { ...s, keys, activeKeyId }
    })
  }, [])

  const deleteKey = useCallback(async (id) => {
    if (onlineRef.current) {
      try {
        const data = await backend.deleteKey(id)
        setSettings((s) => ({
          ...s,
          keys: (data.keys || []).map(normalizeKey),
          activeKeyId: data.activeKeyId,
        }))
        return
      } catch {
        /* fallthrough */
      }
    }

    setSettings((s) => {
      const keys = s.keys.filter((k) => k.id !== id)
      const activeKeyId = s.activeKeyId === id ? (keys[0]?.id ?? null) : s.activeKeyId
      return { ...s, keys, activeKeyId }
    })
  }, [])

  const activateKey = useCallback(
    async (id) => {
      if (onlineRef.current) {
        try {
          const data = await backend.activateKey(id)
          const keys = (data.keys || []).map(normalizeKey)
          setSettings((s) => ({
            ...s,
            keys,
            activeKeyId: data.activeKeyId,
          }))
          const active = keys.find((k) => k.id === data.activeKeyId)
          if (active) void refreshModelsForKey(active)
          return
        } catch {
          /* fallthrough */
        }
      }

      const active = settings.keys.find((k) => k.id === id) || null
      setSettings((s) => ({ ...s, activeKeyId: id }))
      if (active) void refreshModelsForKey(active)
    },
    [refreshModelsForKey, settings.keys],
  )

  useEffect(() => {
    const active = getActiveKey(settings)
    if (!active?.id || !active.baseUrl || !active.apiKey) return
    if (active.availableModels?.length > 0) return

    const signature = `${active.id}|${active.baseUrl}|${active.apiKey}`
    if (autoRefreshRef.current === signature) return
    autoRefreshRef.current = signature
    void refreshModelsForKey(active)
  }, [refreshModelsForKey, settings])

  const setActiveModel = useCallback(
    async (model) => {
      const active = getActiveKey(settings)
      if (!active) return
      await saveKey({
        ...active,
        model,
        availableModels: active.availableModels || (active.model ? [active.model] : []),
      })
    },
    [saveKey, settings],
  )

  const setParams = useCallback(async (params) => {
    setSettings((s) => ({ ...s, ...params }))
    if (onlineRef.current) {
      try {
        await backend.setParams(params)
      } catch {
        /* ignore */
      }
    }
  }, [])

  const importKeys = useCallback(async (keys, activeKeyId) => {
    const normalized = keys.map(normalizeKey)

    if (onlineRef.current) {
      try {
        const data = await backend.importKeys(normalized, activeKeyId)
        setSettings((s) => ({
          ...s,
          keys: (data.keys || []).map(normalizeKey),
          activeKeyId: data.activeKeyId,
        }))
        return
      } catch {
        /* fallthrough */
      }
    }

    setSettings((s) => ({
      ...s,
      keys: normalized,
      activeKeyId: activeKeyId ?? normalized[0]?.id ?? null,
    }))
  }, [])

  return {
    settings,
    online,
    vault,
    saveKey,
    deleteKey,
    activateKey,
    setActiveModel,
    setParams,
    importKeys,
    validateKey,
    vaultSetup,
    vaultUnlock,
    vaultLock,
    vaultChange,
    vaultDisable,
    vaultAutolock,
    vaultBackup,
    vaultRestore,
  }
}

