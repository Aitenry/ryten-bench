/**
 * Global active-workspace context (shared by the AI tool layer and the IPC layer).
 * The provider is injected by the main process at startup; chat tools run inside the main process and
 * read the current active workspace through this module, keeping data isolation consistent with the
 * IPC layer.
 */
let provider: () => number = () => 0

export function setActiveWorkspaceIdProvider(fn: () => number): void {
  provider = fn
}

export function getActiveWorkspaceId(): number {
  return provider()
}
