import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateState } from '../../../shared/update/types'

/**
 * Renderer-side update state.
 *
 * The main process owns the state machine and pushes snapshots; this hook only mirrors them and
 * exposes the three user intents. Keeping the bridge here means the update entry does not know
 * where packages come from (GitHub today, Lattice later).
 */
export function useAppUpdate(): {
  state: AppUpdateState | null
  download: () => void
  restart: () => Promise<boolean>
} {
  const [state, setState] = useState<AppUpdateState | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.appUpdate
      .getState()
      .then((snapshot) => {
        if (alive) setState(snapshot)
      })
      .catch((error) => {
        console.error('[app-update] Failed to read update state:', error)
      })

    const unsubscribe = window.api.appUpdate.onState((snapshot) => {
      if (alive) setState(snapshot)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const download = useCallback((): void => {
    void window.api.appUpdate.download().catch((error) => {
      console.error('[app-update] Download request failed:', error)
    })
  }, [])

  const restart = useCallback(async (): Promise<boolean> => {
    try {
      return await window.api.appUpdate.restart()
    } catch (error) {
      console.error('[app-update] Restart request failed:', error)
      return false
    }
  }, [])

  return { state, download, restart }
}
