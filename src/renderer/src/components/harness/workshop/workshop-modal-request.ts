/**
 * Cross-route open request for the "Plugin Workshop" modal.
 *
 * Background: the plugin workshop UI moved from the settings modal to the plugin repository page
 * (`Modal` + `WorkshopSettings embedded` inside `PluginRepository`), while the sidebar
 * (`HarnessSidebar`) lives under the Harness route — a different subtree from the plugin
 * repository — so clicking a plugin row in the sidebar has to "navigate to /plugins, open the
 * workshop and expand this plugin", which only works through a cross-route pending request (the
 * same module-level snapshot approach as `settings-modal-state.ts`).
 *
 * Why not CustomEvent: the event fires before navigation, so the target page is not mounted yet
 * and never hears it (the old implementation lost events this way; users only saw the settings
 * modal or a blank page). Here the request is stashed and taken by the target page via `take()`
 * once mounted.
 */
export interface WorkshopModalRequest {
  /** Draft id to expand; undefined = only open the workshop list */
  draftId?: string
}

let pending: WorkshopModalRequest | null = null
const listeners = new Set<() => void>()

/** Request opening the plugin workshop (usually immediately followed by navigate('/plugins')) */
export function requestWorkshopModal(draftId?: string): void {
  pending = { draftId }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (err) {
      console.error('[workshop] Error in open-request subscription callback:', err)
    }
  }
}

/** Take the pending request (cleared after taking, so re-entering the page doesn't reopen the modal) */
export function takeWorkshopModalRequest(): WorkshopModalRequest | null {
  const request = pending
  pending = null
  return request
}

/** Subscribe to "a new open request arrived" (so the plugin repository page can react while mounted) */
export function subscribeWorkshopModalRequest(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}
