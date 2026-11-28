import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp } from 'antd'
import Root from './Root'
import { LanguageProvider } from './contexts/LanguageContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { installHostUi } from './plugin-host/host-ui'

/**
 * Host UI table (plugin render bundles take `@host/**` and vendor instances such as react/antd
 * from here). It must be installed **before any plugin render module is fetched**: plugins load
 * asynchronously (in the PluginStateBridge effect) and the generated bridge module depends on the
 * key → export names reported here, so installing it at module evaluation time (before React
 * renders) is the most reliable place.
 */
installHostUi()

/**
 * Uncaught errors / unhandled Promise rejections: print the **stack** to the console.
 *
 * Why this is needed (2026-09-19): Electron's `console-message` only carries the first line of
 * the message and the renderer had no global handler, so the log was left with a bare
 * `Uncaught TypeError: Cannot read properties of undefined (reading 'startTime')` — no file, no
 * line number, no stack — while a static sweep (renderer sources, antd/rc, react-dom) ruled out
 * every known read site. This handler makes the next occurrence carry its own context.
 *
 * Report only, never `preventDefault`: the default behaviour (red text in DevTools, error
 * boundaries, etc.) is completely unchanged. The same error is reported at most 5 times per
 * session so an exception loop cannot flood the log.
 */
const reportedUncaught = new Set<string>()
const UNCAUGHT_REPORT_LIMIT = 5

function reportUncaught(kind: string, error: unknown, fallback: string): void {
  const err = error as { message?: string; stack?: string } | undefined
  const key = `${kind}:${err?.message ?? fallback}`
  if (reportedUncaught.has(key)) return
  if (reportedUncaught.size >= UNCAUGHT_REPORT_LIMIT) return
  reportedUncaught.add(key)
  console.error(`[Uncaught:${kind}] ${err?.message ?? fallback}\n${err?.stack ?? '(no stack)'}`)
}

window.addEventListener('error', (event) => {
  reportUncaught('error', (event as ErrorEvent).error, (event as ErrorEvent).message ?? '')
})
window.addEventListener('unhandledrejection', (event) => {
  reportUncaught('rejection', (event as PromiseRejectionEvent).reason, '')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Language sits outermost: both the theme (antd locale) and dayjs follow it */}
    <LanguageProvider>
      <ThemeProvider>
        <AntApp>
          <Root />
        </AntApp>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>
)
