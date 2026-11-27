import React from 'react'
import { useTheme } from '@renderer/hooks/useTheme'
import { getProviderColor, getProviderMonogram } from '@renderer/utils/providerMeta'

/**
 * 供应商「首字母」徽章：没有品牌图标的供应商（尤其自定义端点）的统一标识。
 *
 * 2026-11-27 用户口径（附输入栏截图）：「自定义的供应商端点的 logo 不好看」。
 * 旧方案是 14px 描边小方块 + 8px 等宽双字母，在 26px 触发条里像一枚键帽/占位符：
 * 描边吃掉 2px、字太小、灰底灰字没有识别度。
 *
 * 现在按「应用图标」的思路做单字母头像：
 * - 无描边、字母占满视觉中心，尺寸由调用方给（输入栏 16px，设置/菜单同尺寸）；
 * - 底色由品牌色按主题调制：暗色向墨色压、亮色向纸白提，字母取同色相的浅/深一阶；
 * - 单字母（不是双字母）：14~16px 下双字母必然挤成一团，首字母已足够区分，全名在设置页/菜单里；
 * - 颜色不在这里发明品牌色：收录过的品牌只从 providerMeta 取色；未收录的自定义端点用应用主色的
 *   低饱和阶（中性灰在暗色里像占位符、在亮色里像键帽；主色阶既能当 logo，也不像随机品牌色那样抢眼）。
 */
const MONO_FONT = "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace"

/** 自定义端点（无品牌色）的基色：应用主色的亮一档，和权限盾牌 / 主按钮同一色系 */
const CUSTOM_ENDPOINT_BASE = '#5b73ff'

interface ProviderMarkProps {
  providerType: string
  /** 徽章边长（px）；字重与圆角随尺寸微调 */
  size?: number
  /** 指定品牌色；缺省按 providerType + 当前主题从 providerMeta 取，未收录时落主色阶 */
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
