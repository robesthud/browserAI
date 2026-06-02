// Шифрование ключей парольной фразой (AES-256-GCM + scrypt).
// Мастер-ключ держим только в памяти процесса, пока «хранилище» разблокировано.

import crypto from 'node:crypto'

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 }
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
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decrypt(payload, key) {
  const [ivB64, tagB64, dataB64] = String(payload).split(':')
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('bad ciphertext')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(data), decipher.final()])
  return dec.toString('utf8')
}

// Создаёт «верификатор» — зашифрованный известный токен (для проверки пароля)
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
