import React from 'react'
import { Button } from 'antd'
import { RiLayoutRightLine, RiLayoutRightFill } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import BackgroundAgentsButton from './BackgroundAgentsButton'

interface HarnessHeaderProps {
  panelOpen: boolean
  onTogglePanel: () => void
  colorBorderSecondary: string
  currentTopicId: number | null
}

/**
 * 对话消息区顶部栏。
 *
 * 只放视角相关的操作（后台智能体入口 / 工作区面板开关），**不显示会话标题**——
 * 会话已在左侧系统侧栏里高亮选中（用户 2026-11-19 口径：顶部不要显示标题；随后又明确
 * 「面板按钮要放在对话消息的顶部，搞一个顶部栏，不要放在输入框里面」）。
 * 空白会话没有消息，不渲染这条栏，输入框与欢迎语一起居中（见 Index 的 isWelcomeMode）。
 */
const HarnessHeader: React.FC<HarnessHeaderProps> = ({
  panelOpen,
  onTogglePanel,
  colorBorderSecondary,
  currentTopicId
}) => {
  const { t } = useTranslation()

  return (
    <div
      className="flex items-center justify-end px-2 py-1 shrink-0"
      style={{ borderBottom: `1px solid ${colorBorderSecondary}` }}
    >
      <div className="flex items-center gap-2.5">
        <BackgroundAgentsButton currentTopicId={currentTopicId} />
        <Button
          type="text"
          size="small"
          title={t('harness.header.togglePanel')}
          icon={panelOpen ? <RiLayoutRightFill size={16} /> : <RiLayoutRightLine size={16} />}
          onClick={onTogglePanel}
        />
      </div>
    </div>
  )
}

export default HarnessHeader
