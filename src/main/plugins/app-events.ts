import logger from 'electron-log'

/**
 * Minimal app event bus on the main-process side (owned by core).
 *
 * Purpose: core "notifies" plugins at fixed moments (e.g. the workspace was switched in system
 * settings) and interested plugins respond themselves. Division of labor with `contributions.ts`:
 * contribution points are **pull** semantics (the host actively runs plugin-provided hooks at fixed
 * moments), events are **push** semantics (core decides when, subscriber count is arbitrary and may
 * be zero). They complement each other and do not replace one another.
 *
 * Semantics:
 * - **synchronous dispatch**: `emitAppEvent` calls subscribers in order and does not await a Promise
 *   returned by a subscriber (hook-style moments use contribution points, which do need awaiting);
 * - **errors swallowed**: a subscriber throwing only logs `logger.warn`, affecting neither later
 *   subscribers nor the core flow (a buggy plugin must not drag the shell down);
 * - **reversible**: `onAppEvent` returns an unbind function; plugins subscribe inside
 *   `ctx.effect(() => onAppEvent(...))` and are unbound automatically on disable (the host never
 *   needs to know which plugins listen).
 */

type AppEventHandler = (payload: unknown) => void

/** Event name → subscriber set (dispatch in insertion order) */
const handlers = new Map<string, Set<AppEventHandler>>()

/** Subscribes to an app event; returns an unbind function (idempotent) */
export function onAppEvent(name: string, handler: AppEventHandler): () => void {
  let set = handlers.get(name)
  if (!set) {
    set = new Set()
    handlers.set(name, set)
  }
  set.add(handler)
  return () => {
    const current = handlers.get(name)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) handlers.delete(name)
  }
}

/** Dispatches an app event (synchronously; a single subscriber error is only logged) */
export function emitAppEvent(name: string, payload?: unknown): void {
  const set = handlers.get(name)
  if (!set || set.size === 0) return
  for (const handler of [...set]) {
    try {
      handler(payload)
    } catch (err) {
      logger.warn(`[AppEvents] Subscriber for event '${name}' failed:`, err)
    }
  }
}

/** Current subscriber count for an event (diagnostics/test assertions only) */
export function appEventListenerCount(name: string): number {
  return handlers.get(name)?.size ?? 0
}
