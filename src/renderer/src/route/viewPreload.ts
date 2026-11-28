/**
 * View chunk preloading (registry-driven)
 *
 * Background: lazily loaded pages (Harness / Planner / Music and external plugin pages) only load
 * their chunk on the first switch to them. While a heavy chunk (such as the whole code editor
 * suite for Harness) downloads and evaluates, the UI stays "stuck on the previous page" for a
 * while.
 *
 * Approach (same as the previous implementation, but registry-driven):
 * 1. During idle periods after startup, import each chunk in batches ahead of time (heavy to
 *    light) so that by the first switch the module has already been evaluated and the target page
 *    renders immediately;
 * 2. Hovering/focusing an item in the sidebar also preloads its chunk, as a fallback while the
 *    idle preload has not finished yet;
 * 3. If it is still not ready, Suspense shows the skeleton screen for that page (see
 *    RouteSkeleton).
 *
 * Plugin semantics: the task list comes from the route loaders of the "enabled plugins" in the
 * host registry; disabled plugins do not take part in preloading.
 */

export type LazyModule = () => Promise<{ default: unknown }>

const inflight = new Map<string, Promise<void>>()

/** Immediately load the chunk for the given plugin; idempotent, repeated calls share one load */
export function preloadView(key: string, load: LazyModule): Promise<void> {
  const running = inflight.get(key)
  if (running) return running
  const task = load()
    .then(() => undefined)
    .catch((err) => {
      // A failed preload does not block usage: Suspense still loads on demand and shows the skeleton
      console.warn(`[preload] Failed to preload view "${key}"`, err)
    })
  inflight.set(key, task)
  return task
}

const scheduledKeys = new Set<string>()

/**
 * Idle preloading after startup: batching in the given order (the caller sorts heavy to light),
 * with each key scheduled only once (a plugin re-enabled at runtime can still schedule new keys).
 */
export function scheduleViewPreload(tasks: { key: string; load: LazyModule }[]): void {
  let slot = 0
  for (const task of tasks) {
    if (scheduledKeys.has(task.key)) continue
    scheduledKeys.add(task.key)
    const delay = 3000 + slot * 2000
    slot += 1
    runWhenIdle(() => preloadView(task.key, task.load), delay, 2500)
  }
}

function runWhenIdle(task: () => void, minDelay: number, idleTimeout: number): void {
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => task(), { timeout: idleTimeout })
    } else {
      task()
    }
  }, minDelay)
}
