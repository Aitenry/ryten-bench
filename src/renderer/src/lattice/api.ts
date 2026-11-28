import type { LatticeApi } from './types'

/**
 * Safe access layer for `window.api.lattice`.
 *
 * preload already provides the types for `api.lattice` (`src/preload/index.d.ts`; the DTO source of
 * truth is `src/main/lattice/types.ts`). Even so, this performs a **runtime probe** instead of
 * reading it directly:
 *
 * - the main process may not have registered the `lattice:*` channels yet (development / older
 *   main process);
 * - unit tests / plain-browser preview environments have no preload, so `window.api` may be
 *   undefined;
 * - when the probe finds no bridge it returns null, and every UI degrades safely (the account area
 *   shows "plugin center not ready").
 */
interface LatticeBridgeHost {
  api?: {
    lattice?: Partial<LatticeApi>
  }
}

/** Get the plugin-center bridge exposed by the main process; returns null when the main process has not registered the channels (callers must degrade) */
export function getLatticeBridge(): LatticeApi | null {
  try {
    const host = window as unknown as LatticeBridgeHost
    const bridge = host.api?.lattice
    if (!bridge) return null
    // Only check one core method: if the main process registered the channels, status() must exist;
    // this keeps a half-initialized object from being treated as a usable bridge
    if (typeof bridge.status !== 'function') return null
    return bridge as LatticeApi
  } catch {
    // Non-browser / restricted environment: treat as no bridge
    return null
  }
}

export function isLatticeBridgeAvailable(): boolean {
  return getLatticeBridge() !== null
}

/** Normalize any exception into a single displayable sentence (errors thrown over main-process IPC are often Error objects or strings) */
export function latticeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === 'string') return maybeMessage
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Error text returned uniformly when the main-process channels are missing (components never display it directly; the UI degrades on `available` first) */
export const LATTICE_BRIDGE_MISSING = 'lattice bridge unavailable'
