import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/**
 * Lock-code hashing and verification (main process only).
 *
 * Why not the old "bare MD5 of a 6-digit number":
 * - 6-digit numbers have only a million combinations and MD5 can compute millions per second — the
 *   `e10adc…` string in settings.json is effectively the plaintext password;
 * - the old implementation also sent the hash to the renderer over IPC (`lock-screen-code`), so any
 *   code injected into the renderer process could simply take it.
 *
 * It now uses **salted scrypt** (N=16384, r=8, p=1, ~16 MiB / a few tens of milliseconds per
 * attempt); the hash stays in the main process and the renderer never sees it. Legacy bare MD5 hashes
 * can still be verified (otherwise upgrading would lock users out); after the first successful
 * verification they are upgraded in place to scrypt by `lock/service.ts`.
 */

/** 6-digit numeric unlock code */
export const LOCK_CODE_PATTERN = /^\d{6}$/

const HASH_PREFIX = 'scrypt'
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
const SALT_BYTES = 16
/** scrypt memory limit: 128 * N * r is the theoretical value; leave a 2x margin for the implementation */
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 2

/** Whether this is an acceptable unlock code (callers use it to reject invalid input) */
export function isLockCode(value: unknown): value is string {
  return typeof value === 'string' && LOCK_CODE_PATTERN.test(value)
}

/** Whether this is a legacy bare MD5 hash (32 hex characters) */
export function isLegacyCodeHash(stored: string): boolean {
  return /^[a-f0-9]{32}$/i.test(stored)
}

/** Whether this is a scrypt hash written by this version */
export function isScryptCodeHash(stored: string): boolean {
  return stored.startsWith(`${HASH_PREFIX}$`)
}

interface ScryptParams {
  n: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

/** Parses `scrypt$N$r$p$salt$hash`; returns null if any part is invalid (better to reject than compute with bad parameters) */
function parseScryptHash(stored: string): ScryptParams | null {
  const parts = stored.split('$')
  if (parts.length !== 6) return null
  const [prefix, rawN, rawR, rawP, rawSalt, rawHash] = parts
  if (prefix !== HASH_PREFIX) return null
  const n = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  // Clamp both lower and upper bounds: the upper bound stops a settings file changed to N=2^30 from freezing the main process
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return null
  const salt = Buffer.from(rawSalt, 'base64url')
  const hash = Buffer.from(rawHash, 'base64url')
  if (salt.length < 8 || hash.length < 16) return null
  return { n, r, p, salt, hash }
}

function deriveKey(
  password: string,
  salt: Buffer,
  keylen: number,
  params: { n: number; r: number; p: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize('NFKC'),
      salt,
      keylen,
      {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: Math.max(MAX_MEM, 128 * params.n * params.r * 2)
      },
      (error, derived) => {
        if (error) reject(error)
        else resolve(derived as Buffer)
      }
    )
  })
}

/** Builds the hash to persist: `scrypt$N$r$p$salt$hash` */
export async function hashLockCode(code: string): Promise<string> {
  if (!isLockCode(code)) throw new Error('lock code must be 6 digits')
  const salt = randomBytes(SALT_BYTES)
  const hash = await deriveKey(code, salt, KEY_LENGTH, {
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  })
  return [
    HASH_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join('$')
}

/** MD5('code') written by older versions, used only for verification and later upgrade */
function legacyMd5Hex(code: string): string {
  return createHash('md5').update(code, 'utf8').digest('hex')
}

/**
 * Verifies the unlock code.
 *
 * Returning `legacy: true` means the match was against the old MD5 hash — the caller should upgrade
 * the hash to scrypt immediately. Any failure (bad hash, unusable scrypt parameters) is treated as
 * "no match": a failed lock check must stay closed, never let through.
 */
export async function verifyLockCode(
  code: string,
  stored: string
): Promise<{ matched: boolean; legacy: boolean }> {
  if (!isLockCode(code) || !stored) return { matched: false, legacy: false }

  if (isLegacyCodeHash(stored)) {
    const expected = Buffer.from(stored.toLowerCase(), 'hex')
    const actual = Buffer.from(legacyMd5Hex(code), 'hex')
    if (expected.length !== actual.length) return { matched: false, legacy: false }
    return { matched: timingSafeEqual(expected, actual), legacy: true }
  }

  const params = parseScryptHash(stored)
  if (!params) return { matched: false, legacy: false }

  try {
    const derived = await deriveKey(code, params.salt, params.hash.length, {
      n: params.n,
      r: params.r,
      p: params.p
    })
    if (derived.length !== params.hash.length) return { matched: false, legacy: false }
    return { matched: timingSafeEqual(derived, params.hash), legacy: false }
  } catch {
    return { matched: false, legacy: false }
  }
}
