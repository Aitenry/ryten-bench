/**
 * In-plugin relay for the "document rewritten by an AI tool" notification.
 *
 * The event source is the harness plugin: it bridges the main process's
 * `harness:harness-doc-changed` into the semantic event `doc:changed` on the **host event bus**
 * (the subscription side lives in `src/renderer/src/events/`). This plugin's `plugin.tsx`
 * subscribes to that event in install and forwards it to this module-level subscription table;
 * components (DocEditorPane) subscribe only to this module—they neither know the harness channel
 * name nor import anything from harness.
 *
 * Why not let components subscribe to the host event bus directly: `HostServices.events` is only
 * available inside the plugin install scope (obtained via `ctx.use('events')`), and React
 * components cannot get the host instance. This follows the same "module-level subscribable
 * snapshot + shell slot" approach.
 */
export interface DocChangedPayload {
  docId: number
  action: 'updated' | 'deleted'
}

const listeners = new Set<(payload: DocChangedPayload) => void>()

/** install side: forward `doc:changed` from the host event bus to the subscribing components */
export const publishDocChanged = (payload: DocChangedPayload): void => {
  for (const listener of [...listeners]) {
    try {
      listener(payload)
    } catch (err) {
      console.error('[plugin:notes] Error in doc:changed handler:', err)
    }
  }
}

/**
 * component side: subscribe to "document rewritten by AI" notifications; returns an unsubscribe
 * function
 */
export const subscribeDocChanged = (
  listener: (payload: DocChangedPayload) => void
): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
