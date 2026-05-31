// ============================================
// AI CODE STUDIO - ENCRYPTION UTILITY (AES-256-GCM)
// Safely encrypts/decrypts API Keys inside Database
// ============================================

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

// Default static fallback key if env variable not present (highly recommended for MVP local runs)
const SECRET_KEY = process.env.ENCRYPTION_KEY || '637172737475767778797a6162636465666768696a6b6c6d6e6o7p7q7r7s7t7u';

export function encrypt(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(SECRET_KEY, 'hex'), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  if (!encryptedText) return '';
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !authTagHex || !encrypted) return encryptedText; // Fallback if raw text (legacy entries)

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(SECRET_KEY, 'hex'), iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.warn('[Decryption] Failed to decrypt value. Returning original text:', error);
    return encryptedText; // fallback to prevent crashes
  }
}
