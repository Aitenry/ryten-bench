import * as crypto from 'crypto'
import * as os from 'os'
import { app } from 'electron'
import logger from 'electron-log'
import _Store from 'electron-store'

const Store = _Store['default'] || _Store
const keystore = new Store({ name: 'provider-keystore' })

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const PBKDF2_ITERATIONS = 600000
const KEY_LENGTH = 32 // 256 bits
const SALT = 'ryten-bench-provider-salt-v1' // Fixed salt, mixed with machine attributes

/**
 * Machine key cache: hostname / username / userData do not change within a session, so the
 * 600k-iteration PBKDF2 runs only once (about 200–500 ms, synchronously blocking the main process).
 * Previously the key was re-derived for every API key encryption/decryption, so batch scenarios
 * (e.g. decrypting 29 models line by line) blocked for several seconds cumulatively and froze
 * the model settings tree while loading.
 */
let cachedMachineKey: Buffer | null = null

/**
 * Derive the encryption key from the current machine attributes
 * Based on a combination of hostname + username + userData path, unique per machine
 */
function deriveMachineKey(): Buffer {
  if (cachedMachineKey) return cachedMachineKey
  const hostname = os.hostname()
  const username = os.userInfo().username
  const userDataPath = app.getPath('userData')

  // Combine the machine-unique identifier
  const machineFingerprint = `${hostname}:${username}:${userDataPath}`

  cachedMachineKey = crypto.pbkdf2Sync(
    machineFingerprint,
    SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  )
  return cachedMachineKey
}

/**
 * Verify that the machine key matches the stored verification token
 * Used to detect machine environment changes (e.g. OS reinstall, username change)
 */
function verifyMachineKey(): boolean {
  const storedToken = keystore.get('key_verification_token') as string | undefined
  if (!storedToken) return true

  const currentKey = deriveMachineKey()
  const currentToken = crypto.createHash('sha256').update(currentKey).digest('hex')

  return currentToken === storedToken
}

/**
 * Initialize the encryption module: generate a verification token (regenerated on first run or
 * when verification fails)
 * Note: if the verification token does not match, the machine environment has changed and
 * previously encrypted data can no longer be decrypted
 */
function initKeystore(): void {
  const storedToken = keystore.get('key_verification_token') as string | undefined

  if (!storedToken) {
    const machineKey = deriveMachineKey()
    const token = crypto.createHash('sha256').update(machineKey).digest('hex')
    keystore.set('key_verification_token', token)
    logger.info('Provider keystore initialized with machine-specific key')
  } else if (!verifyMachineKey()) {
    logger.warn(
      'Machine fingerprint changed! Encrypted provider keys may be unreadable. ' +
        'If you recently changed your system, re-enter your API keys.'
    )
  }
}

/**
 * Encrypt an API key
 * Uses AES-256-GCM authenticated encryption and returns Base64-encoded ciphertext
 * Format: iv (16 bytes) + authTag (16 bytes) + ciphertext → Base64
 */
function encryptApiKey(plaintext: string): string {
  const key = deriveMachineKey()
  const iv = crypto.randomBytes(IV_LENGTH)

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Concatenate: iv + authTag + ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted])
  return combined.toString('base64')
}

/**
 * Decrypt an API key
 * Restores the plaintext from Base64-encoded ciphertext
 */
function decryptApiKey(encryptedBase64: string): string {
  if (!encryptedBase64) return ''

  try {
    const key = deriveMachineKey()
    const combined = Buffer.from(encryptedBase64, 'base64')

    const iv = combined.subarray(0, IV_LENGTH)
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf8')
  } catch (error) {
    logger.error('Failed to decrypt API key:', error)
    throw new Error(
      'Failed to decrypt API key. The machine environment may have changed. ' +
        'Please re-enter your API keys in provider settings.'
    )
  }
}

export { initKeystore, encryptApiKey, decryptApiKey, verifyMachineKey }
