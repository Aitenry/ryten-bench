import React, { useEffect, useState } from 'react'
import { theme } from 'antd'
import { RiPuzzleLine } from '@remixicon/react'
import { declaredIconGlyph } from '@renderer/plugin-host/declared-icons'

/**
 * Plugin **brand icon** (shared by plugin repository cards and the plugin detail page).
 *
 * The icon source has two forms depending on the manifest (see `PluginManifest.icon` in
 * `shared/plugin/types.ts`):
 * - `menu.icon` / built-in plugins' `icon`: a **remixicon name** (e.g. `RiTiktokFill`) —
 *   name -> component resolution lives in `plugin-host/declared-icons.tsx` (first-frame allowlist
 *   + brand supplement table), so the same glyph is used here and the card and the sidebar menu
 *   show the same plugin;
 * - external plugins' `icon`: `plugin://<id>/icon.svg` or a `data:` URI — rendered directly as an
 *   image; the `plugin://` protocol only serves installed plugins (discoverable entries that are
 *   not installed get no file).
 *
 * When neither is available (or the name does not resolve), fall back to a "brand-color gradient
 * hashed from the id + puzzle piece": the same plugin always gets the same color, so entries stay
 * distinguishable in a list.
 */
const ICON_COLORS = [
  ['#2dd4bf', '#0d9488'],
  ['#fb923c', '#ef4444'],
  ['#a78bfa', '#7c3aed'],
  ['#fbbf24', '#f59e0b'],
  ['#60a5fa', '#2563eb'],
  ['#34d399', '#059669']
]

function colorFor(id: string): [string, string] {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return ICON_COLORS[hash % ICON_COLORS.length] as [string, string]
}

/**
 * Render as an image only when the `icon` field is an image URL (rather than a remixicon name);
 * CSP only allows data:/blob:/plugin:
 */
function imageUrlOf(icon: string | undefined): string | undefined {
  if (!icon) return undefined
  return /^(?:data:|blob:|plugin:)/i.test(icon) ? icon : undefined
}

export interface PluginIconProps {
  /** Plugin id: the brand color is hashed from it so the same plugin keeps a stable color */
  id: string
  /** Manifest `icon` field: a remixicon name, or `plugin://<id>/icon.svg` / a `data:` URI */
  icon?: string
  /** Manifest `menu.icon`: used when `icon` is absent, the same one as in the sidebar menu */
  menuIcon?: string
  /** Icon edge length (px), default 42 (repository card); the detail page header uses 54 */
  size?: number
}

const PluginIcon: React.FC<PluginIconProps> = ({ id, icon, menuIcon, size = 42 }) => {
  const { token } = theme.useToken()
  const url = imageUrlOf(icon)
  const [broken, setBroken] = useState(false)

  // Give the image another chance whenever the plugin/icon URL changes (after an upgrade an icon
  // may turn from a placeholder into a real image)
  useEffect(() => setBroken(false), [url])

  const [from, to] = colorFor(id)
  const radius = size >= 50 ? 15 : 12
  const glyphSize = size >= 50 ? 24 : 19
  const glyph = declaredIconGlyph(url ? menuIcon : (icon ?? menuIcon), glyphSize)

  if (url && !broken) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          overflow: 'hidden',
          flexShrink: 0,
          background: token.colorFillQuaternary,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16), 0 2px 5px rgba(17,24,39,.12)'
        }}
      >
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setBroken(true)}
        />
      </span>
    )
  }

  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(135deg, ${from}, ${to})`,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16), 0 2px 5px rgba(17,24,39,.12)'
      }}
    >
      {glyph ?? <RiPuzzleLine size={glyphSize} />}
    </span>
  )
}

export default PluginIcon
