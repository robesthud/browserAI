// Шифрование ключей парольной фразой (AES-256-GCM + scrypt).
// Мастер-ключ держим только в памяти процесса, пока «хранилище» разблокировано.

import crypto from 'node:crypto'

// N читается из env для настройки без пересборки.
// OWASP рекомендует N≥16384. Default 16384 — безопасно и не роняет scrypt на 1.5GB VPS.
// Снижено с 32768: при mem_limit=1500m и одновременном агенте scryptSync падал с
// "memory limit exceeded" и вход в аккаунт ломался.
const SCRYPT_N = Number(process.env.SCRYPT_N) || 16384
const SCRYPT_PARAMS = { N: SCRYPT_N, r: 8, p: 1, keylen: 32 }
const VERIFIER_TOKEN = 'browserai-vault-v1'

export function generateSalt() {
  return crypto.randomBytes(16).toString('hex')
}

export function deriveKey(passphrase, saltHex) {
  const salt = Buffer.from(saltHex, 'hex')
  return crypto.scryptSync(passphrase, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  })
}

// Шифрует строку. Возвращает компактную строку "iv:tag:ciphertext" (base64).
export function encrypt(plaintext, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key)
  if (keyBuf.length !== 32) throw new Error(`encrypt: key must be 32 bytes, got ${keyBuf.length}`)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv)
  const enc = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decrypt(payload, key) {
  const parts = String(payload).split(':')
  const ivB64 = parts[0]
  const tagB64 = parts[1]
  const dataB64 = parts.slice(2).join(':') // dataB64 может теоретически содержать ':' в future formats
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('bad ciphertext')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(data), decipher.final()])
  return dec.toString('utf8')
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  // Синхронная версия — только для начального создания пользователя (не в hot path)
  const hash = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_PARAMS.N, r: 8, p: 1 }).toString('hex')
  return `${salt}:${hash}`
}

// Асинхронная версия — используется при логине чтобы не блокировать event loop
// и не превышать mem_limit контейнера (scryptSync резервирует ~N*128 байт разом)
export function passwordHashAsync(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: SCRYPT_PARAMS.N, r: 8, p: 1 }, (err, buf) => {
      if (err) return reject(err)
      resolve(`${salt}:${buf.toString('hex')}`)
    })
  })
}

export async function verifyPassword(password, stored = '') {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const next = await passwordHashAsync(password, salt)
  const nextHash = next.split(':')[1]
  const hashBuf = Buffer.from(hash, 'hex')
  const nextBuf = Buffer.from(nextHash, 'hex')
  // timingSafeEqual требует одинаковую длину буферов
  if (hashBuf.length !== nextBuf.length) return false
  return crypto.timingSafeEqual(hashBuf, nextBuf)
}

// #3 FIX: используем HKDF для вывода ключа шифрования из AUTH_SECRET.
let cachedEncryptionKey = null;
function encryptionKey() {
  const AUTH_SECRET = process.env.AUTH_SECRET || 'change-me-in-production-very-long-secret-string';
  if (!process.env.AUTH_SECRET && process.env.NODE_ENV === 'production') {
    console.error('[crypto] CRITICAL: AUTH_SECRET is not set! Cloud sync data is encrypted with a known default key. Set AUTH_SECRET in environment.')
  }
  if (cachedEncryptionKey) return cachedEncryptionKey;
  cachedEncryptionKey = crypto.hkdfSync(
    'sha256',
    Buffer.from(AUTH_SECRET, 'utf8'),
    Buffer.from('browserai-cloud-encryption-salt-v1', 'utf8'),
    Buffer.from('browserai-cloud-encryption', 'utf8'),
    32,
  )
  return cachedEncryptionKey;
}

export function encryptJson(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update((() => { try { return JSON.stringify(value ?? {}) } catch { return '{}' } })(), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptJson(payload) {
  const [version, ivB64, tagB64, dataB64] = String(payload || '').split(':')
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error('decryptJson: decrypted payload is not valid JSON (data may be corrupted)')
  }
}

// Создаёт «верификатор» — зашифрованный известный токен (для проверки пароля)
// Только для тестов: сброс кеша ключа при смене AUTH_SECRET
export function _resetEncryptionKeyCache() { cachedEncryptionKey = null }

export function makeVerifier(key) {
  return encrypt(VERIFIER_TOKEN, key)
}

export function checkVerifier(verifier, key) {
  try {
    return decrypt(verifier, key) === VERIFIER_TOKEN
  } catch {
    return false
  }
}
