import logger from 'electron-log'

/**
 * EffectScope — 可逆效应作用域（论文 §3.1 的工程落地）
 *
 * 每次对话/Agent 执行对应一个 scope：
 * - 通过 effect() 注册「效果 + 逆」；dispose() 时按 LIFO 顺序调用全部逆；
 * - armed 标志保证逆至多执行一次（幂等，同论文 Algorithm 1）；
 * - AbortSignal 触发时自动 dispose。
 */
export class EffectScope {
  private readonly inverses: Array<() => Promise<void> | void> = []
  private readonly abortHandlers: Array<() => void> = []
  private armed = true
  private disposed = false

  constructor(signal?: AbortSignal) {
    if (signal) {
      const onAbort = (): void => {
        void this.dispose()
      }
      if (signal.aborted) {
        // 已中止：直接解除武装（逆不会再执行）
        this.armed = false
        this.disposed = true
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        this.abortHandlers.push(() => signal.removeEventListener('abort', onAbort))
      }
    }
  }

  /** 注册一个带逆的效果；dispose 时按 LIFO 恢复 */
  async effect<T>(run: () => Promise<T>, undo: () => Promise<void> | void): Promise<T> {
    if (!this.armed) {
      // 已回收（或信号预中止）：效果不再注册，逆由调用方自行处理
      logger.warn('[EffectScope] 已回收，效果未注册')
      return await run()
    }
    // 效果失败不回滚（尚未产生副作用），交给调用方处理；成功则以 LIFO 组合逆
    const result = await run()
    this.inverses.unshift(undo)
    return result
  }

  /** 登记取消回调（AbortSignal 触发或 dispose 时调用） */
  onAbort(fn: () => void): void {
    if (!this.armed) {
      fn()
      return
    }
    this.abortHandlers.push(fn)
  }

  /** 回收：按 LIFO 执行全部逆，且至多执行一次 */
  async dispose(): Promise<void> {
    if (!this.armed) return
    this.armed = false

    // 先执行 abort 回调，再执行逆
    for (const handler of this.abortHandlers) {
      try {
        handler()
      } catch (err) {
        logger.warn('[EffectScope] abort handler failed:', err)
      }
    }
    this.abortHandlers.length = 0

    for (const inverse of this.inverses) {
      try {
        await inverse()
      } catch (err) {
        logger.warn('[EffectScope] inverse failed:', err)
      }
    }
    this.inverses.length = 0
    this.disposed = true
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}
