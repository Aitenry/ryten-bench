/**
 * 工具调用防循环护栏：识别「同一工具 + 同一参数」在**没有任何可观察进展**时的重复调用。
 *
 * 为什么不能按累计次数一刀切（2026-11-23 用户事故）：插件工坊的四个工具天生是
 * 「同参数重复执行」的——`plugin_build` / `plugin_verify` 每一轮都用同一个 id，
 * `plugin_publish install` 在修复后也要用同一个 id 重试。旧实现把**整轮对话内**
 * 相同参数的调用累计计数（第 3 次就拦），模型改完代码再跑一次就被判成死循环，
 * 只能眼睁睁卡住。真正该拦的是「调用没让状态变化」：同样的参数**产出同样的结果**，
 * 说明这次调用什么也没推动，重复它毫无意义。
 *
 * 判定规则（任一命中即拦截**下一次**调用）：
 * 1. **相同结果**：同一 key 连续产出完全相同的输出达到 `identicalResultLimit` 次
 *    （默认 3）——中间可以夹杂别的工具调用；只要结果变了（源码/状态变了）就重新计数；
 * 2. **连续同调用**：同一 key 连续出现达到 `consecutiveLimit` 次（默认 4），
 *    用于兜住「结果每次都不一样但调用本身在原地打转」的极端情况。
 *
 * 纯逻辑、零依赖，离线工装可直接 import（见 `test/verify-repeat-guard.mjs`）。
 */

/** 拦截原因（决定给模型的提示语） */
export type RepeatBlockReason = 'identical-result' | 'consecutive'

/** 一次拦截判定 */
export interface RepeatVerdict {
  blocked: boolean
  reason?: RepeatBlockReason
  /** 触发拦截时已经发生的次数（给模型看「重复了几次」） */
  count: number
}

export interface RepeatGuardOptions {
  /** 同一调用连续产出相同结果的次数上限（达到后拦截下一次） */
  identicalResultLimit?: number
  /** 同一调用连续出现的次数上限（达到后拦截下一次） */
  consecutiveLimit?: number
}

export const DEFAULT_IDENTICAL_RESULT_LIMIT = 3
export const DEFAULT_CONSECUTIVE_LIMIT = 4

/** 单个 key 的历史（只留判定需要的最小状态，避免长会话里攒下整段输出） */
interface KeyState {
  /** 上一次结果的摘要 */
  lastDigest: string
  /** 连续相同结果的次数 */
  identicalRun: number
}

/**
 * 归一化输出里**每次都会变、但不代表进展**的噪声：耗时、时间戳。
 *
 * 没有这一步，「验收失败 → 重试发布」这种循环会因为报告里的 `1234ms` 每次都不同而被
 * 当成「有进展」，护栏永远不触发。只抹掉确定无意义的格式，不碰文件大小/失败项/错误码
 * ——那些变了就是真的变了。
 */
function normalizeOutput(text: string): string {
  return text
    .replace(/\d+(?:\.\d+)?\s?ms\b/g, '<ms>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<time>')
    // 溢出文件定位符每次都是新 UUID（内容再一样也会不同），不能算进展
    .replace(
      /spill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt/gi,
      'spill-<id>.txt'
    )
}

/**
 * 稳定摘要：FNV-1a 32 位 + 长度。
 *
 * 只用于「两次输出是不是同一份」，不做安全用途；带上长度后不同内容撞车的概率
 * 低到可以忽略，且比保存整段工具输出省内存。输出通常几 KB～20KB，O(n) 无压力。
 */
function digest(text: string): string {
  const normalized = normalizeOutput(text)
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`
}

export class RepeatGuard {
  private readonly identicalResultLimit: number
  private readonly consecutiveLimit: number
  private readonly states = new Map<string, KeyState>()
  private lastKey: string | undefined
  private consecutive = 0

  constructor(options: RepeatGuardOptions = {}) {
    this.identicalResultLimit = Math.max(
      2,
      Math.floor(options.identicalResultLimit ?? DEFAULT_IDENTICAL_RESULT_LIMIT)
    )
    this.consecutiveLimit = Math.max(
      2,
      Math.floor(options.consecutiveLimit ?? DEFAULT_CONSECUTIVE_LIMIT)
    )
  }

  /**
   * 执行前判定这次调用该不该被拦。
   *
   * 只看**已经发生**的记录：第一次调用永远不会被拦，所以护栏不会误伤正常的第一步。
   */
  check(key: string): RepeatVerdict {
    const state = this.states.get(key)
    if (state && state.identicalRun >= this.identicalResultLimit) {
      return { blocked: true, reason: 'identical-result', count: state.identicalRun }
    }
    if (key === this.lastKey && this.consecutive >= this.consecutiveLimit) {
      return { blocked: true, reason: 'consecutive', count: this.consecutive }
    }
    return { blocked: false, count: state?.identicalRun ?? 0 }
  }

  /** 执行后记录这次结果（拦截掉的调用不要调用本方法：它没有产生新状态） */
  record(key: string, output: string): void {
    const next = digest(output)
    const state = this.states.get(key)
    // 「这次调用本身有没有产出新东西」：第一次调用不算进展，之后结果变了才算
    const changed = state !== undefined && state.lastDigest !== next
    if (!state) {
      this.states.set(key, { lastDigest: next, identicalRun: 1 })
    } else if (state.lastDigest === next) {
      state.identicalRun += 1
    } else {
      // 同一调用的结果变了 = 状态被推动了（哪怕只是构建输出里的耗时不同）→ 重新计数
      state.lastDigest = next
      state.identicalRun = 1
    }

    /**
     * 别的工具产出了**新结果** = 世界状态变了（改完源码、重新验收通过…）：
     * 把其它条目「一直没变」的计数清零，让之前被判重复的调用再试一次。
     *
     * 没有这一步会出现死锁：publish 连续被拒 3 次后被拦 → 模型去改代码、重新 verify，
     * 但 publish 的计数还停在 3，于是同一个（此时已经能成功的）install 调用永远进不去。
     */
    if (changed) {
      for (const [otherKey, other] of this.states) {
        if (otherKey !== key) other.identicalRun = 0
      }
    }

    if (key === this.lastKey) {
      this.consecutive += 1
    } else {
      this.lastKey = key
      this.consecutive = 1
    }
  }

  /** 清空全部状态（图实例复用/测试用） */
  reset(): void {
    this.states.clear()
    this.lastKey = undefined
    this.consecutive = 0
  }
}

/**
 * 给模型的拦截提示。
 *
 * 刻意点名「如果刚改过源码，应该先 build/verify 而不是重试安装」——插件工坊里
 * 最常见的就是这个误重试；笼统的 "stop repeating" 不会让模型找到下一步。
 */
export function repeatGuardMessage(toolName: string, verdict: RepeatVerdict): string {
  const what =
    verdict.reason === 'identical-result'
      ? `has returned the identical result ${verdict.count} times for exactly the same arguments, so calling it again cannot change anything`
      : `has been called ${verdict.count} times in a row with exactly the same arguments and is making no progress`
  const workshopHint = toolName.startsWith('plugin_')
    ? ' If you just edited plugin sources, run plugin_build and then plugin_verify; if plugin_publish was refused, fix the reason it stated instead of retrying it.'
    : ''
  return (
    `The tool "${toolName}" ${what}.${workshopHint} ` +
    `Do not repeat this call: change the inputs/files involved, or stop and report what you already know.`
  )
}
