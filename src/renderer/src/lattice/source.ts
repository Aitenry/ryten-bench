/**
 * Renderer bridge for the plugin center v2 API (source / republish / asset download / import
 * local plugin directory).
 *
 * Background: the main-process v2 work and the renderer work were parallel tasks; once the
 * main-process types (`src/preload/index.d.ts`) land, these methods are required on
 * `window.api.lattice`, but a **running older main process / preload** may still lack them. So
 * pages never call `window.api.lattice.xxx` directly; instead they:
 * - use `detectLatticeV2Capabilities()` to learn which v2 capabilities the running main process
 *   supports, and disable entries accordingly;
 * - call the wrapper methods exposed by `LatticeProvider` (which uses `getLatticeV2Bridge()`
 *   internally).
 *
 * This way the UI on an older main process only hides/disables the affected entries with a hint
 * instead of throwing `xxx is not a function`.
 */
import { getLatticeBridge } from './api'
import type {
  LatticeBridgeV2,
  LatticeOpenSourceResult,
  LatticeV2CapabilityKey,
  LatticeV2Methods
} from './types'

export type { LatticeV2CapabilityKey }

/** Which v2 capabilities the running main process supports (false = older main process; UI disables the entry with a hint) */
export type LatticeV2Capabilities = Record<LatticeV2CapabilityKey, boolean>

/** Names of the v2 methods (order = the order of the capability hints in the UI) */
const V2_CAPABILITY_KEYS: LatticeV2CapabilityKey[] = [
  'publishInstalled',
  'sourcePath',
  'localSource',
  'openSource',
  'republish',
  'downloadAsset',
  'importLocalDir'
]

/** Get the v1+v2 shaped bridge; returns null when the main process has not registered the lattice channel */
export function getLatticeV2Bridge(): LatticeBridgeV2 | null {
  return getLatticeBridge()
}

/** Detect which v2 channels the current main process provides (computed once at provider init; capabilities never change during the app lifetime) */
export function detectLatticeV2Capabilities(): LatticeV2Capabilities {
  const bridge = getLatticeV2Bridge()
  // Probe the runtime shape rather than the type: these keys are undefined on an older preload
  const runtime = bridge as unknown as Partial<Record<keyof LatticeV2Methods, unknown>> | null
  const capabilities = {} as LatticeV2Capabilities
  for (const key of V2_CAPABILITY_KEYS) {
    capabilities[key] = typeof runtime?.[key] === 'function'
  }
  return capabilities
}

/** Whether an `openSource` result fell back to the file manager (no conversation created) */
export function isFolderFallback(
  result: LatticeOpenSourceResult
): result is { ok: true; opened: 'folder'; path?: string } {
  return result.ok && 'opened' in result && result.opened === 'folder'
}

/** Whether an `openSource` result actually opened a plugin conversation (a workspace id is available) */
export function isChatOpened(
  result: LatticeOpenSourceResult
): result is {
  ok: true
  workspaceId: number
  topicId?: number
  mode?: 'conversation'
  path?: string
} {
  return result.ok && 'workspaceId' in result && typeof result.workspaceId === 'number'
}
