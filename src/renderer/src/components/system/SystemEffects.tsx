import { useEffect, type FC } from 'react'
import { harnessApi } from '@renderer/api/harness'
import { publishDocChanged, type DocChangedPayload } from '@renderer/events/doc-changed'
import { handleProbeRequest } from '@renderer/workshop/probe'

/**
 * Two in-process bridges between system features (mounted once for the app lifetime):
 *
 * - Documents written by the AI assistant's main process → the `notes` editor's `doc:changed`
 *   subscriber table;
 * - The plugin workshop's live-loading probe for plugin renderer modules.
 *
 * Both are features compiled into the app itself, so they call the public module APIs directly —
 * no detour through the plugin event bus and no "which plugin subscribed to which channel"
 * indirection.
 */
const SystemEffects: FC = () => {
  useEffect(() => {
    const unsubDoc = harnessApi.harness.onDocChanged((data) => {
      publishDocChanged(data as DocChangedPayload)
    })
    const unsubProbe = harnessApi.workshop.onProbe((payload) => {
      void handleProbeRequest(payload)
    })
    return () => {
      unsubDoc?.()
      unsubProbe?.()
    }
  }, [])
  return null
}

export default SystemEffects
