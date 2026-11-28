/**
 * Login page: where it came from and where to return.
 *
 * Background (user requirement 2026-11-23): the exit of the login page used to be
 * hardcoded to `/plugins` (the plugin repository) — the plugin session remembered in the
 * sidebar was still there, but the main area switched to the plugin repository, so
 * "whichever content I select, coming back always selects the plugin repository". The
 * login page should return to the page where the user was before entering: entering from
 * the conversation page returns to the conversation page (the sidebar restores the
 * remembered mode / session), entering from the plugin repository returns to the plugin
 * repository. Successful login and "an already logged-in user opens the login page again"
 * go through the same exit, avoiding the same wrong jump.
 *
 * Recording: AppShell stores the current address in a module variable on every
 * **non-login** route change (always hit within a single run) and copies it to
 * sessionStorage (so it survives refresh / hot reload). The login page itself is never
 * recorded, otherwise "back" would land on the login page again.
 */

const STORAGE_KEY = 'rytenbench.lattice.loginReturn'

/** Fallback when there is no record: the app home page (conversation page), i.e. what the login page button calls "workspace" */
export const DEFAULT_LOGIN_RETURN = '/harness'

/** Last non-login address within the same run */
let lastRoute: string | null = null

/** Only accept in-app absolute paths; the login page itself, empty paths and protocol-relative addresses are not valid return targets */
function isReturnable(route: unknown): route is string {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) return false
  if (route === '/') return false
  return (
    route !== '/login' &&
    !route.startsWith('/login/') &&
    !route.startsWith('/login?') &&
    !route.startsWith('/login#')
  )
}

/** Called by AppShell whenever it lands on a non-login page: remember this page so the login page can return to it */
export function rememberLoginReturn(route: string): void {
  if (!isReturnable(route)) return
  lastRoute = route
  try {
    window.sessionStorage.setItem(STORAGE_KEY, route)
  } catch {
    // When sessionStorage is unavailable keep only the in-memory record: returns still work within the same run
  }
}

/** Login page exit: return to the page before entering; with no record (login page opened directly via deep link) go to the workspace */
export function resolveLoginReturn(): string {
  if (isReturnable(lastRoute)) return lastRoute
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY)
    if (isReturnable(saved)) return saved
  } catch {
    // Ignore: fall back to the default target
  }
  return DEFAULT_LOGIN_RETURN
}
