import { useSyncExternalStore } from 'react'

/**
 * State of the native window title (the title bar drawn by Windows).
 *
 * User requirement 2026-11-20: the title shows as `current content - RytenBench`, where
 * content depends on the current selection: the plugin name, or the mode (conversation
 * mode / work mode / plugin mode), or a system page (library / plugin repository).
 *
 * Three sources, priority plugin > route > harness:
 * - `plugin`: pages that know the plugin name explicitly, such as the plugin detail page;
 * - `route`: system pages (library / plugin repository / third-party plugin routes);
 * - `harness`: the work/conversation/plugin mode inside the conversation page (written by
 *   the sidebar mode switch).
 */
const APP_NAME = 'RytenBench'

type TitleSource = 'route' | 'harness' | 'plugin'

const parts: Record<TitleSource, string> = { route: '', harness: '', plugin: '' }

const resolve = (): string => {
  const part = (parts.plugin || parts.route || parts.harness || '').trim()
  return part ? `${part} - ${APP_NAME}` : APP_NAME
}

let current = resolve()
const listeners = new Set<() => void>()

function emit(): void {
  const next = resolve()
  if (next === current) return
  current = next
  listeners.forEach((listener) => listener())
}

/** Set the title fragment for one source kind (empty string means none) */
export function setWindowTitleSource(source: TitleSource, part: string): void {
  const next = part.trim()
  if (parts[source] === next) return
  parts[source] = next
  emit()
}

export function getWindowTitle(): string {
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Subscribe to the current window title in a component (synced to the main process on change) */
export function useWindowTitle(): string {
  return useSyncExternalStore(subscribe, getWindowTitle, () => APP_NAME)
}
