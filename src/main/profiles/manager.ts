import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 账号级本地数据空间（WeChat 式「换号 = 换本地数据容器」）。
 *
 * 背景：安装记录与插件快照在**平台**侧是按账号隔离的（`hub_plugin_installs` 主键
 * `(user_id, plugin_id)`），但客户端本地一直是「整机一份」：同一个 `RytenBenchDB`、
 * `plugin-state/`、`lattice-sync.json` 被所有账号共用。换账号时会出现
 * 「B 账号看到 A 的账本、并把 A 的数据推到 B 云端」这类串号事故。
 *
 * 模型：
 * - **机器级**（不随账号变）：`lattice-session.json`（登录态）、基址、插件包、日志；
 * - **账号级**（本文件管理）：`RytenBenchDB/`、`plugin-state/`、`lattice-sync.json`；
 * - 正在使用的账号数据始终摆在 userData 根下（DB / 插件硬编码的路径不用改），
 *   其它账号的数据摆在 `userData/profiles/<key>/` 里休眠；切号 = 两组目录对调；
 * - 未登录 = 独立的 `anonymous` 容器：未登录期间的插件数据留在本机空间，
 *   **不会**因为之后登录而被并入任何账号（严格隔离）。
 *
 * 安全措施：
 * - 目录对调前先写 journal（`profiles/.switch.json`），启动时据此续做/回滚；
 * - 对调本身只依赖「根目录 + 容器目录」的原子 rename，不复制数据；调用时机有两处：
 *   启动早期（DB 打开、插件装载之前，`runtime.ts`）与**运行中原地切换**
 *   （`live.ts`：先停流/停同步/关 DB/卸插件，再对调、重连、刷新窗口）；
 * - 异常状态（源和目标同时存在）不合并、不覆盖：把多出来的那份挪到
 *   `profiles/.orphan/<时间戳>/` 留给人工恢复，并记一条 conflict。
 *
 * 本模块刻意不依赖 electron：`userDataDir` 由调用方传入，便于用普通 Node 做单测。
 */

/** 未登录账号的容器 key */
export const ANONYMOUS_PROFILE = 'anonymous'

/**
 * 需要在账号之间对调的数据（顺序无关；目录或文件都支持）。
 *
 * 这里只放**插件相关**的数据：插件表都在 RytenBenchDB 里，插件设置/状态在
 * `plugin-state/`，同步游标在 `lattice-sync.json`。AI 会话（`chat/`）、文件历史
 * （`file-history/`）等目前仍是机器级共享的；如果要连它们一起隔离，把目录名加进
 * 这个数组即可（启动时整目录 rename，逻辑与现有条目完全一致）。
 */
export const PROFILE_ITEMS = ['RytenBenchDB', 'plugin-state', 'lattice-sync.json'] as const
export type ProfileItem = (typeof PROFILE_ITEMS)[number]

const PROFILES_DIR = 'profiles'
const MARKER_FILE = '.active.json'
const JOURNAL_FILE = '.switch.json'
const ORPHAN_DIR = '.orphan'
const SESSION_FILE = 'lattice-session.json'

/** 容器 key 只允许安全字符（key 都由本模块生成，这里再兜一层） */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/

/**
 * Windows 上「刚关闭」的目录可能还有句柄没释放（PGlite 的 worker / 杀毒扫描 / 索引器），
 * rename 会以 EBUSY / EPERM / EACCES 失败。运行中切换账号数据空间时这种时序很常见，
 * 因此退避重试几次；退避用同步 sleep——调用方本来就要在这一小段时间里挂起主进程
 * （界面马上会被刷新盖住），比让 rename 一步失败把用户赶回「重启应用」要好。
 */
const RENAME_RETRIES = 4
const RENAME_RETRY_BASE_MS = 80
const RETRYABLE_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

function renameWithRetry(from: string, to: string): void {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= RENAME_RETRIES; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      lastError = err
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt === RENAME_RETRIES) break
      sleepSync(RENAME_RETRY_BASE_MS * (attempt + 1))
    }
  }
  throw lastError
}

/** 从 `lattice-session.json` 里读出来的最小身份（不解密 refresh token） */
export interface SessionIdentity {
  /**
   * 文件里有非空 refresh token（= 这台机器认为自己已登录）。
   * 与 `userId` 区分：旧会话可能只有 token、还没补到 user id。
   */
  loggedIn: boolean
  userId: string | null
  username?: string | null
  baseUrl?: string | null
}

/** `profiles/.active.json`：**根目录当前这套数据属于哪个 key** */
export interface ProfileMarker {
  version: 1
  key: string
  userId?: string | null
  username?: string | null
  baseUrl?: string | null
  updatedAt: number
}

/** `profiles/.switch.json`：一次尚未完成的目录对调 */
export interface ProfileJournal {
  version: 1
  from: string
  to: string
  /** `out` = 还没把根目录数据搬进 from；`in` = 正在把 to 的数据搬回根目录 */
  stage: 'out' | 'in'
  startedAt: number
}

export interface ApplyProfileResult {
  /** 应用后生效的 key */
  key: string
  /** 应用前的 key（`null` = 首次运行，根目录数据被本 key 认领） */
  from: string | null
  /** 本次调用是否真的改变了数据布局 / 写了 marker */
  changed: boolean
  /** 是否恢复了一次被中断的切换 */
  recovered: boolean
  /** 首次运行时根目录已有数据，被当前 key 认领（没有搬动） */
  claimedExisting: boolean
  /** 本次真正搬动的条目 */
  moved: ProfileItem[]
  /** 异常冲突（对应条目被挪到 `.orphan/`） */
  conflicts: ProfileItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exists(target: string): boolean {
  try {
    fs.accessSync(target)
    return true
  } catch {
    return false
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
  } catch {
    return null
  }
}

/** 原子写 JSON（tmp + rename），避免半截 marker/journal 把下次启动带沟里 */
function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmp, file)
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`非法的账号数据空间 key: ${key}`)
}

/* ────────────────────────────── 路径 ────────────────────────────── */

export function profilesRoot(userDataDir: string): string {
  return path.join(userDataDir, PROFILES_DIR)
}

export function profileDir(userDataDir: string, key: string): string {
  assertKey(key)
  return path.join(profilesRoot(userDataDir), key)
}

export function profileMarkerPath(userDataDir: string): string {
  return path.join(profilesRoot(userDataDir), MARKER_FILE)
}

export function profileJournalPath(userDataDir: string): string {
  return path.join(profilesRoot(userDataDir), JOURNAL_FILE)
}

export function profileSessionPath(userDataDir: string): string {
  return path.join(userDataDir, SESSION_FILE)
}

/* ────────────────────────────── 身份 / key ────────────────────────────── */

/**
 * 读登录身份（只读明文部分；refresh token 是否可解密不归这里管）。
 *
 * 只要文件里没有非空 refresh token，就按「未登录」处理——避免 token 被清掉后
 * 仍把数据归到旧账号。
 */
export function readSessionIdentity(userDataDir: string): SessionIdentity {
  const raw = readJson(profileSessionPath(userDataDir))
  if (!isRecord(raw)) return { loggedIn: false, userId: null }
  const token = typeof raw.refreshToken === 'string' ? raw.refreshToken : ''
  if (token === '') return { loggedIn: false, userId: null }
  const user = isRecord(raw.user) ? raw.user : null
  const rawId = user && typeof user.id === 'string' ? user.id.trim() : ''
  const username = user && typeof user.username === 'string' ? user.username : null
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : null
  return { loggedIn: true, userId: rawId === '' ? null : rawId, username, baseUrl }
}

/**
 * 账号 → 本地容器 key。
 *
 * 带上基址哈希：不同 Lattice 节点可能有相同的用户 id，不能共用容器。
 * 没有用户 id（未登录 / 旧会话还没补身份）→ `anonymous`。
 */
export function deriveProfileKey(identity: SessionIdentity): string {
  const userId = (identity.userId ?? '').trim()
  if (userId === '') return ANONYMOUS_PROFILE
  const baseUrl = (identity.baseUrl ?? '').trim()
  const digest = createHash('sha256').update(`${baseUrl}\n${userId}`).digest('hex').slice(0, 16)
  return `u-${digest}`
}

/* ────────────────────────────── marker / journal ────────────────────────────── */

export function readProfileMarker(userDataDir: string): ProfileMarker | null {
  const raw = readJson(profileMarkerPath(userDataDir))
  if (!isRecord(raw)) return null
  if (raw.version !== 1) return null
  if (typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key)) return null
  return {
    version: 1,
    key: raw.key,
    userId: typeof raw.userId === 'string' ? raw.userId : null,
    username: typeof raw.username === 'string' ? raw.username : null,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : null,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  }
}

export function writeProfileMarker(
  userDataDir: string,
  key: string,
  identity?: SessionIdentity
): void {
  assertKey(key)
  const marker: ProfileMarker = {
    version: 1,
    key,
    userId: identity?.userId ?? null,
    username: identity?.username ?? null,
    baseUrl: identity?.baseUrl ?? null,
    updatedAt: Date.now()
  }
  ensureDir(profileDir(userDataDir, key))
  writeJsonAtomic(profileMarkerPath(userDataDir), marker)
}

function readProfileJournal(userDataDir: string): ProfileJournal | null {
  const raw = readJson(profileJournalPath(userDataDir))
  if (!isRecord(raw)) return null
  if (raw.version !== 1) return null
  if (typeof raw.from !== 'string' || !KEY_PATTERN.test(raw.from)) return null
  if (typeof raw.to !== 'string' || !KEY_PATTERN.test(raw.to)) return null
  if (raw.stage !== 'out' && raw.stage !== 'in') return null
  return {
    version: 1,
    from: raw.from,
    to: raw.to,
    stage: raw.stage,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0
  }
}

function writeProfileJournal(userDataDir: string, journal: ProfileJournal): void {
  writeJsonAtomic(profileJournalPath(userDataDir), journal)
}

function clearProfileJournal(userDataDir: string): void {
  try {
    fs.rmSync(profileJournalPath(userDataDir), { force: true })
  } catch {
    // journal 删不掉不影响正确性：下次启动按 marker 状态重放即可
  }
}

/* ────────────────────────────── 搬动 ────────────────────────────── */

/**
 * 异常冲突：同一份数据在「根目录」和「目标容器」同时存在。
 *
 * 不合并、不删除：把**多出来的那份**（调用方指定的 path）挪进 `.orphan/<时间戳>/`，
 * 保留原文件名，方便人工找回。
 */
function moveToOrphan(userDataDir: string, sourcePath: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const orphanDir = path.join(profilesRoot(userDataDir), ORPHAN_DIR, stamp)
  ensureDir(orphanDir)
  const dest = path.join(orphanDir, path.basename(sourcePath))
  renameWithRetry(sourcePath, dest)
  return dest
}

function noteMoved(moved: ProfileItem[], item: ProfileItem): void {
  if (!moved.includes(item)) moved.push(item)
}

/** 根目录 → 某个账号容器（切出）；幂等：已经搬走的不再搬 */
function drainToProfile(
  userDataDir: string,
  key: string,
  moved: ProfileItem[],
  conflicts: ProfileItem[]
): void {
  const dir = profileDir(userDataDir, key)
  ensureDir(dir)
  for (const item of PROFILE_ITEMS) {
    const source = path.join(userDataDir, item)
    if (!exists(source)) continue
    const dest = path.join(dir, item)
    if (exists(dest)) {
      // 只可能出现在异常/人工干预过的目录里：根目录这份是"活的"，容器里那份是旧的
      moveToOrphan(userDataDir, dest)
      conflicts.push(item)
    }
    renameWithRetry(source, dest)
    noteMoved(moved, item)
  }
}

/** 某个账号容器 → 根目录（切入）；幂等：已经搬进来的不再搬 */
function fillFromProfile(
  userDataDir: string,
  key: string,
  moved: ProfileItem[],
  conflicts: ProfileItem[]
): void {
  ensureDir(userDataDir)
  const dir = profileDir(userDataDir, key)
  ensureDir(dir)
  for (const item of PROFILE_ITEMS) {
    const source = path.join(dir, item)
    if (!exists(source)) continue
    const dest = path.join(userDataDir, item)
    if (exists(dest)) {
      // 根目录已有同名条目：这份是当前布局不该出现的，挪进 orphan，以容器里的为准
      moveToOrphan(userDataDir, dest)
      conflicts.push(item)
    }
    renameWithRetry(source, dest)
    noteMoved(moved, item)
  }
}

/** 恢复被中断的切换（按 journal 的 stage 续做；两个方向都幂等） */
function resumeSwitch(
  userDataDir: string,
  journal: ProfileJournal,
  moved: ProfileItem[],
  conflicts: ProfileItem[]
): void {
  if (journal.from !== journal.to) {
    if (journal.stage === 'out') {
      drainToProfile(userDataDir, journal.from, moved, conflicts)
      writeProfileJournal(userDataDir, { ...journal, stage: 'in' })
    }
    fillFromProfile(userDataDir, journal.to, moved, conflicts)
  }
  // 先写 marker 再删 journal：即使 marker 写失败，下次也会按 journal 重放
  writeProfileMarker(userDataDir, journal.to)
  clearProfileJournal(userDataDir)
}

/* ────────────────────────────── 主入口 ────────────────────────────── */

/**
 * 让根目录变成 `desiredKey` 的数据空间（应用启动早期调用，DB/插件装载之前）。
 *
 * 三种情况：
 * 1. 有未完成的切换 → 先续做；
 * 2. 首次运行（没有 marker）→ 根目录现有数据交给 `desiredKey` 认领（不搬动）；
 * 3. marker 与 desired 不同 → 对调两组目录。
 */
export function applyProfile(
  userDataDir: string,
  desiredKey: string,
  identity?: SessionIdentity
): ApplyProfileResult {
  assertKey(desiredKey)
  ensureDir(userDataDir)
  ensureDir(profilesRoot(userDataDir))
  ensureDir(profileDir(userDataDir, desiredKey))

  const result: ApplyProfileResult = {
    key: desiredKey,
    from: null,
    changed: false,
    recovered: false,
    claimedExisting: false,
    moved: [],
    conflicts: []
  }

  // ① 续做上次没完成的切换
  const journal = readProfileJournal(userDataDir)
  if (journal) {
    resumeSwitch(userDataDir, journal, result.moved, result.conflicts)
    result.recovered = true
  }

  const marker = readProfileMarker(userDataDir)

  // ② 首次运行：根目录数据归当前 desired（升级后用户的现有数据不会丢，也不会被搬动）
  if (!marker) {
    const hasExisting = PROFILE_ITEMS.some((item) => exists(path.join(userDataDir, item)))
    writeProfileMarker(userDataDir, desiredKey, identity)
    result.changed = true
    result.claimedExisting = hasExisting
    return result
  }

  // ③ 已经在目标空间里：什么都不用做
  if (marker.key === desiredKey) {
    result.from = marker.key
    return result
  }

  // ④ 对调：根目录（旧账号）→ profiles/from，profiles/to → 根目录
  const from = marker.key
  writeProfileJournal(userDataDir, {
    version: 1,
    from,
    to: desiredKey,
    stage: 'out',
    startedAt: Date.now()
  })
  drainToProfile(userDataDir, from, result.moved, result.conflicts)
  writeProfileJournal(userDataDir, {
    version: 1,
    from,
    to: desiredKey,
    stage: 'in',
    startedAt: Date.now()
  })
  fillFromProfile(userDataDir, desiredKey, result.moved, result.conflicts)
  writeProfileMarker(userDataDir, desiredKey, identity)
  clearProfileJournal(userDataDir)

  result.from = from
  result.changed = true
  return result
}
