import React, { useEffect, useRef, useState } from 'react'
import { Tooltip } from 'antd'

/** 数字等宽字体：计数里的数字用等宽字形，避免位数变化时整行抖动 */
export const MONO_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

/** 工具卡片文本：单行显示 + 溢出省略，悬停展示完整内容（无箭头 Tooltip，仅在溢出时出现）
 *
 *  三个易踩的坑，都在这里一次性收口：
 *  1. 省略号只对「块级（或块化）且宽度受约束」的盒子生效。此前这里是内联 span，
 *     overflow/text-overflow 被完全忽略，且 clientWidth 恒为 0 → 长文本（execute 的整条命令）
 *     直接顶破卡片、悬停提示还对短文本误触发。故此处显式 display:block，并加 1px 容差。
 *  2. 光泽必须做在「承载文字的那一个元素」上：外层 ShinyText 包内层截断 span 时省略号会失效；
 *     且外层基色若用 colorText，暗色主题下基色与高光几乎同色，看起来「只有图标在发光」。
 *     这里用 shinyBaseColor（与 ShinyIcon 同基色）+ 纯白高光，明暗两种主题下都清晰可见。
 *  3. **排版属性要落在 Tooltip 的外层盒子上**（2026-09-27）：调用方一直传 `flex: 1`，但它写在
 *     内层 span 上——对内层来说 `flex` 没有任何意义（它不在 flex 容器里），真正参与卡片
 *     横向分配的是 Tooltip 生成的**外层 div**，而它默认是块级、宽度吃满整行。于是
 *     右侧的元信息/箭头被挤到卡片外面，主文本只是被卡片的 `overflow: hidden` 裁掉——
 *     省略号能不能看见全看容器，换个容器（窄侧栏、嵌套卡片）就变成「文字被挤出去」。
 *     现在外层盒子自己带 `flex: 1 1 auto; min-width: 0`，参与收缩与分配，省略号不再靠裁剪兜底。
 */

/**
 * 调用方常常顺手把 `flex: 1` 写进 `style` —— 那是给外层盒子的，内层 span 上留着没有意义
 * （还可能盖住本组件自己的 `display` 之类关键属性）。这里显式剔掉，由 `wrapperStyle` 承接。
 */
const stripLayoutProps = (style?: React.CSSProperties): React.CSSProperties | undefined => {
  if (!style) return style
  const { flex, flexGrow, flexShrink, flexBasis, alignSelf, ...rest } = style
  void flex
  void flexGrow
  void flexShrink
  void flexBasis
  void alignSelf
  return rest
}

export const TruncatedTooltipText: React.FC<{
  text: string
  style?: React.CSSProperties
  /** 外层盒子（Tooltip 的容器，即卡片里的那个 flex 项）的样式；参与横向分配的属性写这里 */
  wrapperStyle?: React.CSSProperties
  /** 光泽基色（传入即启用光泽扫过；建议与同排 ShinyIcon 的 baseColor 一致） */
  shinyBaseColor?: string
  /** 光泽高光色，默认纯白（与 ShinyIcon 扫过色一致） */
  shinyShineColor?: string
}> = ({ text, style, wrapperStyle, shinyBaseColor, shinyShineColor = '#fff' }) => {
  const spanRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const el = spanRef.current
    if (!el) return
    const check = (): void => {
      setOverflow(el.scrollWidth > el.clientWidth + 1)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])

  return (
    <Tooltip title={overflow ? text : ''} arrow={false} styles={{ root: { maxWidth: 560 } }}>
      {/* 外层盒子：flex 项 + 省略号的宽度约束都在它身上（见文件头第 3 条） */}
      <div
        data-truncated-text
        style={{
          flex: '1 1 auto',
          // 没有 min-width: 0 的 flex 项不会收缩到内容宽度以下（省略号就永远不生效）
          minWidth: 0,
          // 刻意**不设 overflow: hidden**：裁剪交给内层 span，外层保持 overflow 可见，
          // 免得哪天弹层挂在盒子内部时被裁掉
          ...wrapperStyle
        }}
      >
        <span
          ref={spanRef}
          className={shinyBaseColor ? 'shiny-text' : undefined}
          style={{
            // 覆盖 .shiny-text 的 display:inline-block —— 省略号必须是块级盒子
            display: 'block',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
            ...(shinyBaseColor
              ? ({
                  '--shiny-base': shinyBaseColor,
                  '--shiny-shine': shinyShineColor
                } as React.CSSProperties)
              : null),
            ...stripLayoutProps(style)
          }}
        >
          {text}
        </span>
      </div>
    </Tooltip>
  )
}

export default TruncatedTooltipText
