/**
 * Logging outlet for the sandbox layer (injectable, defaults to console).
 *
 * Why sandbox/* must not import electron-log directly: the sandbox service has to run standalone
 * in **any node environment** — local tooling, Linux/macOS container verification, and a future
 * CLI all rely on it; importing electron-log would break those scenarios with an unresolved
 * dependency (measured: pnpm's node_modules are Windows absolute-path symlinks and fail with
 * ERR_MODULE_NOT_FOUND when mounted into a Linux container).
 * This layer therefore depends only on node built-ins; the Electron side injects the real logger
 * when the plugin installs.
 */

export interface SandboxLogger {
  info(message: string): void
  warn(message: string, ...args: unknown[]): void
}

const defaultLogger: SandboxLogger = {
  info: (message) => console.log(message),
  warn: (message, ...args) => console.warn(message, ...args)
}

let current: SandboxLogger = defaultLogger

/** Inject a log implementation (the Electron side calls this once when the plugin installs) */
export function setSandboxLogger(logger: SandboxLogger): void {
  current = logger
}

/** Restore the default (for tooling/tests) */
export function resetSandboxLogger(): void {
  current = defaultLogger
}

/** Unified logging outlet for the sandbox layer */
export const sandboxLog: SandboxLogger = {
  info: (message) => current.info(message),
  warn: (message, ...args) => current.warn(message, ...args)
}
