import React, { useEffect, useState } from 'react'
import App from './App'
import StartupSplash from './components/system/StartupSplash'
import { AppErrorBoundary } from './components/system/AppErrorBoundary'
import { useWindowTitle } from './window-title'

/**
 * Sync the current window title to the main process (the native title bar shows
 * `content - RytenBench`).
 *
 * The title content is declared in various places via `setWindowTitleSource` (plugin name /
 * page name / conversation mode, etc.); this component only subscribes and forwards it over IPC.
 */
const WindowTitleSync: React.FC = () => {
  const title = useWindowTitle()
  useEffect(() => {
    try {
      ;window.api.window.setTitle(title)
    } catch {
      // Ignore when the platform does not support it
    }
  }, [title])
  return null
}

/**
 * Root component: main UI + startup splash.
 *
 * The main UI mounts on the first frame (initialization data loads in the background) and the
 * splash sits on top; once all initialization tasks finish and the main UI's first frame is
 * ready, the splash fades out and unmounts (see StartupSplash).
 */
const Root: React.FC = () => {
  const [startupDone, setStartupDone] = useState(false)
  return (
    // The error boundary also covers the splash and title sync: previously `AppErrorBoundary`
    // only wrapped the inside of App, so an error during startup (StartupSplash timers or
    // subscriptions) would unmount the whole tree and blank the screen.
    <AppErrorBoundary>
      <WindowTitleSync />
      <App />
      {!startupDone && <StartupSplash onDone={() => setStartupDone(true)} />}
    </AppErrorBoundary>
  )
}

export default Root
