import React from 'react'

/**
 * 对话主区的底部输入区外壳（主智能体 / 子智能体共用）。
 *
 * 用户 2026-11-26 口径："全部内容实现复用" —— 主对话和子代理会话的输入区必须是
 * 同一套外壳：同样的左右留白、最大宽度、背景、顶部分隔线和渐隐遮罩、欢迎态居中宽度。
 * 差异只在内层控件（主对话放完整 HarnessInput，子代理放 simpleMode 的 HarnessInput）
 * 与上半部分的主题卡片（目标/任务/队列只属于主对话，用 `top` 槽位传）。
 */
interface ConversationFooterProps {
  /** 空白会话（欢迎页）布局：无顶部分隔线、更窄的最大宽度、上下留白更大 */
  welcome?: boolean
  /** 输入框上方的主题卡片（主对话：任务进度 / 目标 / 队列；子代理没有） */
  top?: React.ReactNode
  colorBgContainer: string
  colorBorderSecondary: string
  children: React.ReactNode
}

const ConversationFooter: React.FC<ConversationFooterProps> = ({
  welcome = false,
  top,
  colorBgContainer,
  colorBorderSecondary,
  children
}) => {
  return (
    <div
      className={`relative px-8 pb-6 ${welcome ? 'pt-4' : 'pt-2'}`}
      style={{
        background: colorBgContainer,
        borderTop: welcome ? 'none' : `1px solid ${colorBorderSecondary}`
      }}
    >
      {/* 输入区上方的渐隐遮罩：滚到边界时消息淡出，不再像被输入框硬生生切断。
          空白会话没有消息可淡出，遮罩只在常规布局里生效。 */}
      {!welcome ? (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -28,
            left: 0,
            right: 0,
            height: 28,
            zIndex: 2,
            pointerEvents: 'none',
            background: `linear-gradient(to bottom, transparent, ${colorBgContainer})`
          }}
        />
      ) : null}
      <div className={`${welcome ? 'max-w-2xl' : 'max-w-4xl'} mx-auto`}>
        {top}
        {children}
      </div>
    </div>
  )
}

export default ConversationFooter
