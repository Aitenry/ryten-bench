import React from 'react'
import PluginCrashCard, { type PluginSurface } from './PluginCrashCard'

// Backward-compatible import path: `PluginSurface` moved to PluginCrashCard.tsx with the card
export type { PluginSurface } from './PluginCrashCard'

/**
 * **Render isolation layer for a single plugin** (the last gate between the host shell and plugin
 * UI).
 *
 * Why it is required: React error boundaries contain failures one level at a time, and the host
 * previously had only the outermost one in `App.tsx` — any render error in a plugin page, settings
 * page, or Provider bubbled all the way to the top, so **the entire app turned into a "RUNTIME
 * ERROR" card**. Plugins are third-party code and should not have that power: only their own block
 * should break, while menus, the sidebar, other plugins, and settings keep working.
 *
 * Three degradation modes (pick by mount point):
 * - **Card** (route / settings): shows which plugin broke and the raw error, plus "retry / disable
 *   plugin";
 * - **Quiet skip** (`quiet` + `fallback`, appProvider / bottomBar): the broken Provider is no
 *   longer rendered while the subtree it wraps keeps rendering (`fallback` is that subtree); the
 *   bottom bar item degrades to a placeholder.
 * - **Fully silent**: no fallback and no card (reserved for mount points without visible UI).
 *
 * Note: an error boundary only catches **render-phase** errors (including child mount/update).
 * Exceptions in event callbacks, timers, and promises are out of scope — those belong to the main
 * process `plugin-guard` and each plugin's own try/catch.
 */

export interface PluginBoundaryProps {
  /** Plugin id used to disable/show the failure */
  pluginId: string
  /** Mount point where the failure occurred (directly locatable in logs) */
  surface: PluginSurface
  children: React.ReactNode
  /**
   * Content rendered on error. A Provider uses "the subtree it wraps", the bottom bar uses a
   * placeholder; when omitted it degrades to the crash card.
   */
  fallback?: React.ReactNode
  /** true = don't show the crash card (render fallback only); for spots where a full notice block is not allowed */
  quiet?: boolean
}

interface PluginBoundaryState {
  error: Error | null
  /** Records which plugin failed: bottom bar carousel/route switches reuse the same boundary instance, so it must reset when the plugin changes */
  pluginId: string
}

export class PluginBoundary extends React.Component<PluginBoundaryProps, PluginBoundaryState> {
  state: PluginBoundaryState = { error: null, pluginId: this.props.pluginId }

  static getDerivedStateFromError(error: Error): Partial<PluginBoundaryState> {
    return { error }
  }

  /** Clear the error when the instance is reused for another plugin (otherwise the new plugin keeps showing the previous plugin's crash card) */
  static getDerivedStateFromProps(
    props: PluginBoundaryProps,
    state: PluginBoundaryState
  ): Partial<PluginBoundaryState> | null {
    if (state.pluginId !== props.pluginId) {
      return { pluginId: props.pluginId, error: null }
    }
    return null
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[plugin:${this.props.pluginId}] ${this.props.surface} failed to render (isolated, host continues running):`,
      error,
      info.componentStack
    )
  }

  /** Retry: clear the error state and render the same subtree again (works for transient errors; a repeat failure is caught again) */
  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    if (this.props.quiet) return null
    return (
      <PluginCrashCard
        pluginId={this.props.pluginId}
        surface={this.props.surface}
        error={error}
        onRetry={this.handleRetry}
      />
    )
  }
}
