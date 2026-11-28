/**
 * Mutex for install / uninstall of the same plugin.
 *
 * Why it is needed: the renderer has several entry points that can send actions for the same
 * plugin at the same time (detail page "update" + version table "install this version", repository
 * card "update" + "update all", sync auto-backfill + manual install by the user). On the main
 * process side, install is "download -> overwrite directory -> enable and load" and uninstall is
 * "delete directory"; the concurrent result depends entirely on completion order: uninstall then
 * land = the uninstalled plugin quietly comes back; install then uninstall = the version just
 * installed is gone again.
 *
 * Semantics: **reject rather than queue**. The call that gets the lock proceeds; later calls get a
 * readable error and the UI says "installing/uninstalling, please wait". Queueing would run an
 * install after "the user already clicked uninstall", which is exactly what must be avoided.
 */

interface ActiveOperation {
  label: string
  startedAt: number
}

const active = new Map<string, ActiveOperation>()
/** All in-progress operations (waited on for shutdown) */
const inFlight = new Set<Promise<unknown>>()

/** Whether an install/uninstall is currently running for a plugin (diagnostics/tests) */
export function isPluginOperationRunning(pluginId: string): boolean {
  return active.has(pluginId)
}

/** The operation currently running (readable label, used in error messages) */
export function currentPluginOperation(pluginId: string): string | null {
  return active.get(pluginId)?.label ?? null
}

/**
 * Wait for all in-progress plugin installs/uninstalls to finish (called before switching the
 * account data space).
 *
 * @returns true = all finished; false = timed out with operations still running (the user data
 * directory must not be swapped then)
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
 * Run one plugin-level operation under the lock; reject immediately when the same id already has
 * an operation.
 *
 * @param label User-readable action name ("installing" / "uninstalling")
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
