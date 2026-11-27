import React, { useState } from 'react'
import { theme } from 'antd'
import { RiSparkling2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import { approvalStyles } from './PermissionApprovalPanel'

/**
 * 动作确认面板（内联）— 模型 `propose_action` 的「要继续吗？」确认。
 *
 * 2026-11-27 用户口径：这个确认要和沙箱授权 UI 一样放在**输入框区域**，复用同一套组件样式
 * （`approvalStyles` + `.inline-approval*` 类），不再只作为消息流里的一张卡片。
 *
 * 语义差异：沙箱授权会**整体让位**输入框（不决定无法继续）；动作确认只是「下一步建议」，
 * 所以放在输入框上方、不锁输入框——用户选一个动作就回传为该动作的回复，或者直接在下面
 * 输入自己的指令。消息流里的历史卡片保留，作为已选动作的留痕。
 */

export interface ProposalActionItem {
  label: string
  description?: string
  reply?: string
}

interface ProposalActionPanelProps {
  question: string
  actions: ProposalActionItem[]
}

const ProposalActionPanel: React.FC<ProposalActionPanelProps> = ({ question, actions }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [picked, setPicked] = useState<string | null>(null)

  const pick = (action: ProposalActionItem): void => {
    if (picked !== null) return
    const text = (action.reply ?? action.label).trim()
    setPicked(text)
    // 与消息卡片走同一个事件：hooks 侧决定直接开新回合还是排队（生成中）
    window.dispatchEvent(new CustomEvent('harness-propose-action', { detail: { text } }))
  }

  return (
    <div className="inline-approval-wrap" data-proposal-panel="1" style={{ marginBottom: 10 }}>
      <div
        className="inline-approval"
        style={{
          borderColor: token.colorPrimaryBorder,
          background: `linear-gradient(180deg, ${token.colorPrimaryBg}, ${token.colorBgElevated} 46%)`,
          boxShadow: '0 12px 30px rgba(0,0,0,.14)'
        }}
      >
        <div className="inline-approval-head">
          <span
            className="inline-approval-icon"
            style={{ color: token.colorPrimary, background: token.colorPrimaryBg }}
          >
            <RiSparkling2Line size={16} />
          </span>
          <div className="inline-approval-title-block">
            <div className="inline-approval-title" style={{ color: token.colorText }}>
              {t('harness.proposal.title')}
            </div>
            <div className="inline-approval-subtitle" style={{ color: token.colorTextTertiary }}>
              {t('harness.proposal.subtitle')}
            </div>
          </div>
          <span
            className="inline-approval-tool"
            style={{ color: token.colorTextTertiary, borderColor: token.colorBorderSecondary }}
          >
            propose_action
          </span>
        </div>

        <div className="inline-approval-reason" style={{ color: token.colorTextSecondary }}>
          {question || t('harness.proposal.fallbackQuestion')}
        </div>

        <div className="inline-approval-foot">
          <span className="inline-approval-hint" style={{ color: token.colorTextTertiary }}>
            {picked
              ? t('harness.proposal.picked', { label: picked })
              : t('harness.proposal.inlineHint')}
          </span>
          <span className="inline-approval-actions">
            {actions.map((action, index) => (
              <button
                key={`${action.label}-${index}`}
                type="button"
                className={`inline-approval-btn${index === 0 ? ' is-primary' : ''}`}
                data-proposal-action={action.label}
                title={action.description}
                disabled={picked !== null}
                onClick={() => pick(action)}
              >
                {action.label}
              </button>
            ))}
          </span>
        </div>
      </div>
      <style>{approvalStyles}</style>
    </div>
  )
}

export default ProposalActionPanel
