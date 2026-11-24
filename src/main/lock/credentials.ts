import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/**
 * 锁屏解锁码的摘要与校验（只在主进程执行）。
 *
 * 为什么不用旧的「6 位数字的裸 MD5」：
 * - 6 位数字只有 100 万种组合，MD5 一秒能算几百万个 —— 拿到 settings.json 里那串
 *   `e10adc…` 等于直接拿到明文密码；
 * - 旧实现还把摘要通过 IPC 下发给渲染层（`lock-screen-code`），任何注入到渲染进程的
 *   代码都能顺手取走它。
 *
 * 现在改为**加盐 scrypt**（N=16384, r=8, p=1，每次 16 MiB / 几十毫秒），摘要只在主进程，
 * 渲染层永远拿不到。旧用户的裸 MD5 仍能校验（否则升级后会被锁在门外），首次校验成功后
 * 由 `lock/service.ts` 原地升级成 scrypt。
 */

/** 6 位纯数字解锁码 */
export const LOCK_CODE_PATTERN = /^\d{6}$/

const HASH_PREFIX = 'scrypt'
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
const SALT_BYTES = 16
/** scrypt 的内存上限：128 * N * r 是理论值，留一倍余量给实现 */
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 2

/** 是否是可接受的解锁码（调用方拿来挡住非法输入） */
export function isLockCode(value: unknown): value is string {
  return typeof value === 'string' && LOCK_CODE_PATTERN.test(value)
}

/** 是否是旧版本的裸 MD5（32 位十六进制） */
export function isLegacyCodeHash(stored: string): boolean {
  return /^[a-f0-9]{32}$/i.test(stored)
}

/** 是否是本版本写下的 scrypt 摘要 */
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

/** 解析 `scrypt$N$r$p$salt$hash`；任何一段不合法都返回 null（宁可不认，也不拿坏参数去算） */
function parseScryptHash(stored: string): ScryptParams | null {
  const parts = stored.split('$')
  if (parts.length !== 6) return null
  const [prefix, rawN, rawR, rawP, rawSalt, rawHash] = parts
  if (prefix !== HASH_PREFIX) return null
  const n = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  // 参数下限/上限都要卡：上限防止设置文件被改成 N=2^30 把主进程算到卡死
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

/** 生成落盘用的摘要：`scrypt$N$r$p$salt$hash` */
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

/** 旧版本写入的 MD5('code')，仅用于校验后升级 */
function legacyMd5Hex(code: string): string {
  return createHash('md5').update(code, 'utf8').digest('hex')
}

/**
 * 校验解锁码。
 *
 * 返回 `legacy: true` 表示这次是拿旧 MD5 比对成功的 —— 调用方应立刻把摘要升级成 scrypt。
 * 任何异常（坏摘要、scrypt 参数不可用）都按「不匹配」处理：锁屏失败必须关闭，不能放行。
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
