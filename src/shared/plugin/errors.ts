/**
 * Plugin system error codes (shared by all three sides).
 *
 * - UNDECLARED_ACCESS: accessing a context key without declaring the dependency
 *   (the capability model);
 * - MISSING_DEP: a declared dependency cannot be satisfied in the current state
 *   (no host key / no active provider);
 * - CHANNEL_FORBIDDEN: channel not registered / plugin not enabled / prefix mismatch
 *   (authoritative check in the main process).
 */

export const PLUGIN_ERROR = {
  UNDECLARED_ACCESS: 'PLUGIN_UNDECLARED_ACCESS',
  MISSING_DEP: 'PLUGIN_MISSING_DEP',
  SERVICE_MISSING: 'PLUGIN_SERVICE_MISSING',
  CHANNEL_FORBIDDEN: 'PLUGIN_CHANNEL_FORBIDDEN',
  ALREADY_ENABLED: 'PLUGIN_ALREADY_ENABLED',
  ALREADY_DISABLED: 'PLUGIN_ALREADY_DISABLED',
  NOT_FOUND: 'PLUGIN_NOT_FOUND',
  INVALID_MANIFEST: 'PLUGIN_INVALID_MANIFEST',
  ALREADY_INSTALLED: 'PLUGIN_ALREADY_INSTALLED'
} as const

export type PluginErrorCode = (typeof PLUGIN_ERROR)[keyof typeof PLUGIN_ERROR]

/** Plugin system error type */
export class PluginError extends Error {
  readonly code: PluginErrorCode

  constructor(code: PluginErrorCode, message: string) {
    super(message)
    this.name = 'PluginError'
    this.code = code
  }
}
