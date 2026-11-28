/**
 * One-shot "open this workspace file when the harness page mounts" request.
 *
 * The schedules page and its run panel live on a different route than the conversation, so
 * "打开产物" has to cross a route change. Router state would force every caller to thread it
 * through, and the workspace panel handle only exists inside the harness page, so a tiny one-shot
 * module value is the least invasive channel: the caller stores the virtual path, navigates, and
 * the harness page consumes it once on mount (the panel handle is deferred until the panel exists,
 * so no timing race).
 *
 * Deliberately not persisted: navigating away without reaching the harness page simply drops the
 * request instead of opening an old file later.
 */
let pendingPath: string | null = null

/** Ask the harness page to open this virtual workspace path once it mounts */
export function requestOpenFile(virtualPath: string): void {
  pendingPath = virtualPath
}

/** Take (and clear) the pending request */
export function consumePendingFile(): string | null {
  const value = pendingPath
  pendingPath = null
  return value
}
