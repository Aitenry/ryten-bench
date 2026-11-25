/**
 * 同一插件的安装 / 卸载互斥锁。
 *
 * 为什么需要：渲染层有多个入口能同时对同一个插件发动作（详情页「更新」+ 版本表「安装此
 * 版本」、仓库卡片「更新」+「更新全部」、同步自动补齐 + 用户手动安装）。主进程这边
 * 安装是「下载 → 覆盖目录 → 启用装载」，卸载是「删目录」，两者并发的结果完全取决于
 * 完成顺序：先卸载后落地 = 插件被安装悄悄复活；先安装后卸载 = 刚装的版本又没了。
 *
 * 语义：**拒绝而不是排队**。拿到锁的调用继续；后来的调用得到一个可读错误，由界面提示
 * 「正在安装/卸载，请稍候」。排队会把「用户已经点了卸载」之后又执行一次安装，正是要避免的。
 */

interface ActiveOperation {
  label: string
  startedAt: number
}

const active = new Map<string, ActiveOperation>()
/** 所有进行中的操作（等待它们收尾用） */
const inFlight = new Set<Promise<unknown>>()

/** 某个插件当前是不是有安装/卸载在进行（诊断/测试用） */
export function isPluginOperationRunning(pluginId: string): boolean {
  return active.has(pluginId)
}

/** 当前进行中的操作（可读标签，用于错误提示） */
export function currentPluginOperation(pluginId: string): string | null {
  return active.get(pluginId)?.label ?? null
}

/**
 * 等所有进行中的插件安装/卸载收尾（账号数据空间切换前调用）。
 *
 * @returns true = 已全部收尾；false = 超时仍有操作在跑（此时不能对调用户数据目录）
 */
export async function waitForPluginOperations(timeoutMs = 15_000): Promise<boolean> {
  if (inFlight.size === 0) return true
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      Promise.allSettled([...inFlight]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 在锁内执行一次插件级操作；同一个 id 已有操作时直接拒绝。
 *
 * @param label 用户可读的动作名（"正在安装" / "正在卸载"）
 */
export async function withPluginOperation<T>(
  pluginId: string,
  label: string,
  run: () => Promise<T>
): Promise<T> {
  const running = active.get(pluginId)
  if (running) {
    throw new Error(`插件 '${pluginId}' ${running.label}，请稍候再试`)
  }
  active.set(pluginId, { label, startedAt: Date.now() })
  const task = (async () => await run())()
  inFlight.add(task)
  try {
    return await task
  } finally {
    inFlight.delete(task)
    active.delete(pluginId)
  }
}
