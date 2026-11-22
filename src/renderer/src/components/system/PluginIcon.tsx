import React, { useEffect, useState } from 'react'
import { theme } from 'antd'
import { RiPuzzleLine } from '@remixicon/react'
import { declaredIconGlyph } from '@renderer/plugin-host/declared-icons'

/**
 * 插件**品牌图标**（插件仓库卡片与插件详情页共用）。
 *
 * 图标来源按清单口径分两种（见 `shared/plugin/types.ts` 的 `PluginManifest.icon`）：
 * - `menu.icon` / 内置插件的 `icon`：**remixicon 名字**（如 `RiTiktokFill`）——
 *   名字 → 组件的解析在 `plugin-host/declared-icons.tsx`（首帧白名单 + 品牌补充表），
 *   所以这里直接用同一枚图标，卡片和侧栏菜单看起来是同一个插件；
 * - 外部插件的 `icon`：`plugin://<id>/icon.svg` 或 `data:` URI —— 直接当图片渲染，
 *   `plugin://` 协议只服务已安装的插件（未安装的可发现条目拿不到文件）。
 *
 * 两样都没有（或名字解析不到）时退回「按 id 散列的品牌色渐变 + 拼图」：
 * 同一插件每次都是同一种颜色，列表里仍能互相区分。
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

/** `icon` 字段是图片地址（而不是 remixicon 名）时才按图片渲染；CSP 只放行 data:/blob:/plugin: */
function imageUrlOf(icon: string | undefined): string | undefined {
  if (!icon) return undefined
  return /^(?:data:|blob:|plugin:)/i.test(icon) ? icon : undefined
}

export interface PluginIconProps {
  /** 插件 id：品牌色按它散列，保证同一插件颜色稳定 */
  id: string
  /** 清单的 `icon` 字段：remixicon 名，或 `plugin://<id>/icon.svg` / `data:` URI */
  icon?: string
  /** 清单的 `menu.icon`：没写 `icon` 时用它，与侧栏菜单同一枚 */
  menuIcon?: string
  /** 图标边长（px），默认 42（仓库卡片）；详情页头图用 54 */
  size?: number
}

const PluginIcon: React.FC<PluginIconProps> = ({ id, icon, menuIcon, size = 42 }) => {
  const { token } = theme.useToken()
  const url = imageUrlOf(icon)
  const [broken, setBroken] = useState(false)

  // 换了插件/图标地址就重新给图片一次机会（列表升级后图标可能从占位变成真图）
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
