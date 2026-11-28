import { theme } from 'antd'
import type { CSSProperties } from 'react'
import { useTheme } from '../../hooks/useTheme'

/**
 * Rhythm and color picking for skeletons (no JSX material; see Skeleton.tsx in the same directory).
 *
 * Split into its own module for two reasons: the eslint react-refresh rule requires component files
 * to export only components; and "pulse CSS + theme color picking" is the shared foundation of
 * route-level skeletons (route/RouteSkeleton.tsx) and component-level skeletons, so keeping it in
 * one place avoids having two sets of colors again.
 */

/**
 * Pulse animation: opacity breathing, works in both light and dark themes.
 *
 * The fallback color deliberately uses "mid gray + low opacity" rather than the light theme's
 * rgba(0,0,0,.06): when `<SkeletonBlock />` is used bare (no preset root node, so --rb-skel-block
 * is unavailable), it must be visible on both light and dark backgrounds — a light-only value
 * blurs into the background in dark themes. Exact colors inside presets still come from CSS
 * variables.
 */
export const SKELETON_CSS = `
.rb-skel-block {
  background: var(--rb-skel-block, rgba(127, 127, 127, 0.16));
  animation: rb-skel-pulse 1.8s ease-in-out infinite;
}
.rb-skel-track {
  background: var(--rb-skel-track, rgba(127, 127, 127, 0.12));
}
@keyframes rb-skel-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .rb-skel-block { animation: none; opacity: 0.8; }
}
`

export interface SkeletonPalette {
  isDark: boolean
  /** Main color block */
  block: string
  /** Weaker base (track / spokes) */
  track: string
  /** Accent touches (Gantt bars, center nodes) */
  accent: string
  /** Hairline */
  hairline: string
}

/**
 * Skeleton colors: follow the app theme by default (useTheme); `dark` can override explicitly —
 * panels with their own dark skin, such as ToolDetailView, do not follow antd tokens.
 */
export function useSkeletonPalette(dark?: boolean): SkeletonPalette {
  const { effectiveTheme } = useTheme()
  const { token } = theme.useToken()
  const isDark = dark ?? effectiveTheme === 'dark'
  return {
    isDark,
    block: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
    track: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
    accent: `color-mix(in srgb, ${token.colorPrimary} 30%, transparent)`,
    hairline: token.colorBorderSecondary
  }
}

/** Expose the picked colors as CSS variables on the skeleton preset root node */
export function skeletonVars(palette: SkeletonPalette): CSSProperties {
  return {
    '--rb-skel-block': palette.block,
    '--rb-skel-track': palette.track
  } as CSSProperties
}
