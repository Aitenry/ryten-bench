import { useEffect, useState } from 'react'
import { harnessApi } from '../api/harness'

/**
 * Global count of running PTY terminals (the "Start" badge in the sidebar + the terminal card on the
 * start page).
 *
 * The main process is the single source of truth: fetch once on mount, then subscribe to session
 * change events, plus a 5s fallback poll (an event may be missed after a window rebuild / plugin
 * reload).
 */
export function usePtyTerminalStats(): number {
  const [alive, setAlive] = useState(0)
  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void harnessApi.ptyTerminal
        .stats()
        .then((result) => {
          if (!disposed && result.ok) setAlive(result.alive)
        })
        .catch(() => {
          // When the assistant plugin is disabled the channel doesn't exist: stay at 0 without erroring
        })
    }
    refresh()
    const unsubscribe = harnessApi.ptyTerminal.onSessionsChanged(refresh)
    const timer = window.setInterval(refresh, 5000)
    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])
  return alive
}
