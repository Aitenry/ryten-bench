/**
 * 工具结果事实登记（callId → 结构化事实）。
 *
 * 为什么需要这条旁路：内置文件工具把结果**以纯文本返回给模型**
 * （read_file 返回文件原文、execute 返回 JSON、写改工具返回本地化确认文本），
 * 文本里没有可靠的结构化信号——失败原因与界面语言相关，替换处数/字节数更是
 * 只存在于工具函数内部的局部变量里。但前端的定制卡片需要这些事实：
 * 失败要显示原因、写入要显示字节、编辑要显示替换处数、读取要显示总行数。
 *
 * 于是让工具在执行期把事实登记到这张表（键 = 本次调用的 toolCallId，
 * 由 agent.ts 注入到 `config.configurable.toolCallId`），流生产者按 callId 取走
 * 并合成卡片。表是进程内、有界的（防长会话泄漏）；取走即删除，缺省不影响任何行为。
 */

export interface ToolResultFacts {
  /** 失败原因（工具返回值是本地化文本，结构化信号只在这里） */
  error?: string
  /** write_file：写入字节数 */
  bytes?: number
  /** edit_file：替换处数 */
  replacements?: number
  /**
   * write_file / edit_file：本次落盘新增 / 删除的行数（差异规模）。
   *
   * 与改动记录（file_change 表）**同源**：都由 workspace/line-diff.ts 的 changeStats
   * 算一次（工具算完既登记事实、又传给记录层），所以卡片上的「+N −M」和资源管理器徽标、
   * 差异视图里的统计永远说同一件事。
   */
  added?: number
  removed?: number
  /** read_file：文件总行数 */
  lines?: number
  /** read_file：输出是否被内联上限截断 */
  truncated?: boolean
  /** read_file：按 offset/limit 读取时的行区间（1 基，闭区间） */
  range?: { start: number; end: number; total: number }
}

/** 登记表容量上限：超出时丢弃最早的条目（正常流不会达到） */
const MAX_ENTRIES = 512

const factsByCallId = new Map<string, ToolResultFacts>()

/** 登记（合并）一次工具调用的结果事实；callId 缺失时静默忽略 */
export function recordToolFacts(callId: string | undefined, patch: ToolResultFacts): void {
  if (!callId) return
  const prev = factsByCallId.get(callId)
  if (prev) {
    factsByCallId.delete(callId)
    factsByCallId.set(callId, { ...prev, ...patch })
  } else {
    factsByCallId.set(callId, patch)
  }
  while (factsByCallId.size > MAX_ENTRIES) {
    const oldest = factsByCallId.keys().next()
    if (oldest.done) break
    factsByCallId.delete(oldest.value)
  }
}

/** 读取（不删除）一次工具调用的结果事实 */
export function peekToolFacts(callId: string | undefined): ToolResultFacts | undefined {
  return callId ? factsByCallId.get(callId) : undefined
}

/** 取走并删除（工具调用收尾时调用，避免长会话堆积） */
export function takeToolFacts(callId: string | undefined): ToolResultFacts | undefined {
  if (!callId) return undefined
  const facts = factsByCallId.get(callId)
  if (facts) factsByCallId.delete(callId)
  return facts
}

/** 测试辅助：清空登记表 */
export function clearToolFacts(): void {
  factsByCallId.clear()
}
