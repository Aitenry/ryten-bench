import React from 'react'
import { useTheme } from '@renderer/hooks/useTheme'
import { getProviderColor, getProviderMonogram } from '@renderer/utils/providerMeta'

/**
 * Provider "initial" badge: the unified mark for providers without a brand icon
 * (custom endpoints in particular).
 *
 * 2026-11-27 user feedback (with an input-bar screenshot): "the logo of a custom provider
 * endpoint looks bad". The old approach was a 14px stroked square with 8px monospace
 * two-letter text, which looked like a keycap/placeholder inside the 26px trigger row:
 * the stroke ate 2px, the text was too small, and grey-on-grey had no recognizability.
 *
 * It is now a single-letter avatar built like an app icon:
 * - no stroke, the letter fills the visual center, and the size comes from the caller
 *   (16px in the input bar, the same size in settings/menus);
 * - the background is the brand color modulated per theme: pressed toward ink in dark mode,
 *   toward paper in light mode; the letter is one lighter/darker step of the same hue;
 * - a single letter (not two): at 14~16px two letters inevitably cram together, the initial
 *   already distinguishes providers, and the full name is in the settings page/menu;
 * - brand colors are not invented here: catalogued brands take their color from providerMeta;
 *   uncatalogued custom endpoints use a desaturated step of the app primary color (neutral
 *   grey reads as a placeholder in dark mode and a keycap in light mode; a primary step still
 *   works as a logo without being as loud as a random brand color).
 */
const MONO_FONT = "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace"

/** Base color for custom endpoints (no brand color): one step lighter than the app primary, the same family as the permission shield / primary button */
const CUSTOM_ENDPOINT_BASE = '#5b73ff'

interface ProviderMarkProps {
  providerType: string
  /** Badge edge length (px); font weight and corner radius are tuned with the size */
  size?: number
  /** Explicit brand color; defaults to providerType + current theme from providerMeta, falling back to the primary scale when unknown */
  color?: string
}

const ProviderMark: React.FC<ProviderMarkProps> = ({ providerType, size = 18, color }) => {
  const { effectiveTheme } = useTheme()
  const isDark = effectiveTheme === 'dark'
  const brand = color ?? getProviderColor(providerType, isDark)
  const base = brand ?? CUSTOM_ENDPOINT_BASE
  const glyph = getProviderMonogram(providerType).slice(0, 1)
  const radius = size <= 14 ? 4 : size <= 18 ? 5 : 6
  const background = isDark
    ? `color-mix(in srgb, ${base} 38%, #1c1c1c)`
    : `color-mix(in srgb, ${base} 18%, #ffffff)`
  const ink = isDark
    ? `color-mix(in srgb, ${base} 30%, #ffffff)`
    : `color-mix(in srgb, ${base} 58%, #111111)`
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center flex-shrink-0 select-none"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background,
        color: ink,
        fontFamily: MONO_FONT,
        fontSize: Math.max(8, Math.round(size * 0.62)),
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: 0
      }}
    >
      {glyph}
    </span>
  )
}

export default ProviderMark
