# Step 5 — Multi-provider + Settings persistence + Vault — DONE

**Статус:** ✅ реализовано и работает в проде (`main`).
**Ключевые файлы:** `core/providers.py`, `core/vault.py`, `core/database.py`, `core/server.py`.

---

## 5.1 Provider switching через OpenHands settings
- `POST /api/keys/:id/activate` → `set_active_key()` + fire-and-forget
  `_sync_active_provider_to_openhands()` пушит ключ в OH `/api/settings`.
- `qualify_model(base_url, model)` добавляет правильный префикс:
  `openai/` (bigmodel/z.ai/deepseek), `anthropic/`, `gemini/`, `openrouter/`.
- Код: `core/providers.py` `qualify_model()`, `push_to_openhands()`.

## 5.2 Settings persistence (params)
- Таблица `params` (`core/database.py`), `GET/PUT /api/params`.
- При `PUT` параметры пушатся в OpenHands (`max_iterations`, `temperature`, ...).

## 5.3 Per-key validation
- `POST /api/validate` — реальный round-trip к провайдеру (1-token chat
  completion) с измерением `latencyMs`. Возвращает `{ok, latencyMs, model|error}`.
- Учитывает особенности: Anthropic `/messages` + `x-api-key`, Gemini `?key=`.
- Код: `core/providers.py` `validate_key()`.

## 5.4 Model catalog
- `GET /api/models?baseUrl=&keyId=` — fetch `/models` или `/v1/models`,
  fallback на hardcoded каталог `_FALLBACK_MODELS`, кэш `_MODELS_TTL=3600` (1 час).
- Код: `core/providers.py` `fetch_models()`.

## 5.5 Vault (шифрование ключей)
- `core/vault.py`: PBKDF2-HMAC-SHA256 (200 000 итераций) → 32-байтный AES-ключ,
  AES-GCM для шифрования секретов. Производный ключ не хранится на диске —
  только `kdf_salt` + `verifier_hash`.
- Формат зашифрованного значения: `enc:v1:<b64-nonce>:<b64-ciphertext>`.
- Полный UI-surface: `status / setup / unlock / lock / change / disable /
  autolock / backup / restore` (`/api/vault/*`).
- Автолок по таймауту (default 30 мин), in-memory кэш ключа.

## Баг-фиксы Step 5
- Маска `enc:`-ключей не должна leak'ать ciphertext → отдаём `maskedApiKey`.
- Секреты никогда не возвращаются в `/api/keys` (отдельное поле маски).
- При upsert с `useStoredSecret=true` и пустым/masked apiKey — сохраняем
  существующий secret из БД.
- Anthropic `x-api-key`, Gemini query `?key=` (не Bearer).

---

## Чек-лист
- [x] 5.1 Provider switching
- [x] 5.2 Settings persistence
- [x] 5.3 Per-key validation + latencyMs
- [x] 5.4 Model catalog + cache + fallback
- [x] 5.5 Vault PBKDF2 + AES-GCM + полный UI surface
