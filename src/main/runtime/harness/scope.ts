import logger from 'electron-log'

/**
 * EffectScope — reversible effect scope (engineering implementation of the effect-scope pattern)
 *
 * Each conversation/agent execution corresponds to one scope:
 * - effect() registers "effect + inverse"; dispose() runs all inverses in LIFO order;
 * - the armed flag guarantees each inverse runs at most once (idempotent);
 * - an AbortSignal trigger disposes automatically.
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
        // Already aborted: disarm right away (inverses will not run)
        this.armed = false
        this.disposed = true
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        this.abortHandlers.push(() => signal.removeEventListener('abort', onAbort))
      }
    }
  }

  /** Register an effect with an inverse; restored in LIFO order on dispose */
  async effect<T>(run: () => Promise<T>, undo: () => Promise<void> | void): Promise<T> {
    if (!this.armed) {
      // Already disposed (or the signal aborted early): no effect is registered; caller handles
      // the inverse
      logger.warn('[EffectScope] Already disposed, effect not registered')
      return await run()
    }
    // A failed effect is not rolled back (it produced no side effects) and is left to the caller;
    // on success the inverse is composed in LIFO order
    const result = await run()
    this.inverses.unshift(undo)
    return result
  }

  /** Register a cancel callback (called on AbortSignal abort or dispose) */
  onAbort(fn: () => void): void {
    if (!this.armed) {
      fn()
      return
    }
    this.abortHandlers.push(fn)
  }

  /** Dispose: run all inverses in LIFO order, at most once */
  async dispose(): Promise<void> {
    if (!this.armed) return
    this.armed = false

    // Run abort callbacks first, then the inverses
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
