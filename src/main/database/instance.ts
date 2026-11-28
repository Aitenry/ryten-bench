import { Database } from './loading'

// Database singleton (kept as a module-level variable)
let database: Database | null = null
// Used to track the initialization process
let initializationPromise: Promise<void> | null = null

/**
 * Signal that initialization has **started**.
 *
 * Why this is needed: initialization only begins at `createLoadingWindow()` (that is when
 * `setInitializationPromise` is called), while `initPluginHost()` runs **before** it — external
 * plugins' main modules are required at that point, and a plugin creating tables during load
 * (which the workshop-generated `main/db/ddl.ts` does) would hit the state of "no instance and no
 * initialization in progress", receiving `Database has not been initialized yet.` and then every
 * channel would get that **cached** failure (observed with the user's personal-ledger: a wall of
 * errors at startup until a restart fixed it).
 *
 * With this signal, `getDatabaseInstance()` **waits for initialization to start** instead of
 * throwing immediately when it has not begun yet.
 */
let markInitStarted: () => void = () => {}
const initStarted = new Promise<void>((resolve) => {
  markInitStarted = resolve
})
let initStartedFlag = false
function noteInitStarted(): void {
  if (initStartedFlag) return
  initStartedFlag = true
  markInitStarted()
}

/**
 * Upper bound for waiting until initialization "starts" (milliseconds).
 *
 * During a normal startup this takes tens of milliseconds; it only runs to the limit when
 * initialization is never triggered (e.g. the main flow throws inside whenReady). The bound exists
 * so callers are **not hung forever**: better to report "not initialized" than to hang silently.
 */
const INIT_START_WAIT_MS = 20_000

/** Inject the database instance (called by the initialization flow) */
export function setDatabaseInstance(db: Database | null): void {
  database = db
  if (db) noteInitStarted()
}

/** Inject the initialization Promise (called by the loading-window creation flow) */
export function setInitializationPromise(promise: Promise<void> | null): void {
  initializationPromise = promise
  if (promise) noteInitStarted()
}

/** Get the in-progress initialization Promise (may be null) */
export function getInitializationPromise(): Promise<void> | null {
  return initializationPromise
}

/** Get the database instance reference (accessed directly for shutdown cleanup etc., without waiting for initialization) */
export function getDatabaseRef(): Database | null {
  return database
}

/**
 * Wait for initialization to **start** (returns immediately if it has already started).
 * The upper bound is `INIT_START_WAIT_MS`: better to report "not initialized" than to hang the
 * caller forever.
 */
async function waitForInitStart(): Promise<void> {
  if (initializationPromise) return
  await Promise.race([
    initStarted,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, INIT_START_WAIT_MS)
      // The timer does not hold the event loop (the caller waits on the signal above; this is only a fallback)
      timer.unref?.()
    })
  ])
}

/**
 * Get the initialized database instance.
 *
 * All three states wait instead of "throwing when there is no instance":
 * - instance ready → return it directly;
 * - initialization in progress → wait for it to complete;
 * - **initialization has not started yet** (the case during plugin loading) → wait for it to start,
 *   then wait for it to complete.
 *
 * @returns Promise<Database> The initialized database instance
 */
export async function getDatabaseInstance(): Promise<Database> {
  if (database) {
    return database
  }

  await waitForInitStart()

  if (initializationPromise) {
    // If initialization is in progress, wait for it to complete
    await initializationPromise
    if (database) {
      return database
    }
  }

  // Timed out / initialization already finished without an instance (initialization failed): report the error truthfully
  throw new Error('Database has not been initialized yet.')
}

/**
 * Wait for initialization to complete.
 * During main-window warm-up the renderer may start before initialization finishes: settings and
 * lock-screen reads must wait for initialization (workspace migration writes back
 * activeWorkspaceId) to finish before returning, to avoid observing pre-migration state.
 *
 * When initialization has **not started** yet, also wait for it to start first (this is the case
 * when plugins call this function during loading; see `waitForInitStart`).
 */
export async function awaitInitialized(): Promise<void> {
  await waitForInitStart()
  if (initializationPromise) await initializationPromise
}
