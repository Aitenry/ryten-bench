import React from 'react'
import { theme } from 'antd'
import { RiShieldKeyholeLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type {
  ApprovalDecision,
  ApprovalRequestView,
  PermissionMode
} from '../../../../shared/harness/types'

/**
 * 权限授权面板（内联）— 从输入区展开，覆盖目标/计划 + 输入框。
 *
 * 替代原来的全屏 Modal：审批出现时，输入区上方与输入框整体让位给这块面板，
 * 消息区仍可查看；决定回写后原样恢复输入区。
 * 语义仍是 DSH 同款：只有「允许一次 / 拒绝」，没有永久放行。
 */
interface PermissionApprovalPanelProps {
  pending: ApprovalRequestView
  submitting: boolean
  onDecide: (decision: ApprovalDecision) => void
}

type PermissionLabelKey =
  | 'harness.permission.readOnly'
  | 'harness.permission.workspaceWrite'
  | 'harness.permission.fullAccess'

function modeLabelKey(mode: PermissionMode): PermissionLabelKey {
  switch (mode) {
    case 'read-only':
      return 'harness.permission.readOnly'
    case 'workspace-write':
      return 'harness.permission.workspaceWrite'
    default:
      return 'harness.permission.fullAccess'
  }
}

const PermissionApprovalPanel: React.FC<PermissionApprovalPanelProps> = ({
  pending,
  submitting,
  onDecide
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  return (
    <div className="inline-approval-wrap">
      <div
        className="inline-approval"
        style={{
          borderColor: token.colorWarningBorder,
          background: `linear-gradient(180deg, ${token.colorWarningBg}, ${token.colorBgElevated} 46%)`
        }}
      >
        <div className="inline-approval-head">
          <span
            className="inline-approval-icon"
            style={{ color: token.colorWarning, background: token.colorWarningBg }}
          >
            <RiShieldKeyholeLine size={17} />
          </span>
          <div className="inline-approval-title-block">
            <div className="inline-approval-title" style={{ color: token.colorText }}>
              {t('harness.approval.title')}
            </div>
            <div className="inline-approval-subtitle" style={{ color: token.colorTextTertiary }}>
              {t('harness.approval.inlineSubtitle')}
            </div>
          </div>
          <span
            className="inline-approval-tool"
            style={{ color: token.colorTextTertiary, borderColor: token.colorBorderSecondary }}
          >
            {pending.toolName}
          </span>
        </div>

        <div className="inline-approval-reason" style={{ color: token.colorTextSecondary }}>
          {pending.reason}
        </div>

        <div className="inline-approval-label" style={{ color: token.colorTextTertiary }}>
          {t('harness.approval.detailLabel')}
        </div>
        <pre
          className="custom-scrollbar inline-approval-detail"
          style={{
            color: token.colorText,
            background: token.colorFillQuaternary,
            borderColor: token.colorBorderSecondary
          }}
        >
          {pending.detail}
        </pre>

        {pending.requestedMode ? (
          <div className="inline-approval-escalation" style={{ color: token.colorTextTertiary }}>
            <RiShieldKeyholeLine size={12} style={{ flex: '0 0 auto', marginTop: 2 }} />
            <span>
              {t('harness.approval.escalationNote', {
                mode: t(modeLabelKey(pending.requestedMode)),
                justification: pending.justification ?? ''
              })}
            </span>
          </div>
        ) : null}

        <div className="inline-approval-foot">
          <span className="inline-approval-hint" style={{ color: token.colorTextTertiary }}>
            {t('harness.approval.inlineHint')}
          </span>
          <span className="inline-approval-actions">
            <button
              type="button"
              className="inline-approval-btn is-deny"
              disabled={submitting}
              onClick={() => onDecide('deny')}
            >
              {t('harness.approval.deny')}
            </button>
            <button
              type="button"
              className="inline-approval-btn is-primary"
              disabled={submitting}
              onClick={() => onDecide('allow-once')}
            >
              {submitting ? t('harness.approval.deciding') : t('harness.approval.allowOnce')}
            </button>
          </span>
        </div>
      </div>
      <style>{approvalStyles}</style>
    </div>
  )
}

const approvalStyles = `
.inline-approval-wrap { position: relative; }
.inline-approval { display: flex; flex-direction: column; border: 1px solid; border-radius: 16px; padding: 14px 15px 13px; box-shadow: 0 18px 42px rgba(0,0,0,.32); }
.inline-approval-head { display: flex; align-items: flex-start; gap: 10px; }
.inline-approval-icon { width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; flex: 0 0 auto; }
.inline-approval-title-block { min-width: 0; }
.inline-approval-title { font-size: 13.5px; font-weight: 600; line-height: 1.35; }
.inline-approval-subtitle { margin-top: 2px; font-size: 10.5px; line-height: 1.5; }
.inline-approval-tool { margin-left: auto; flex: 0 0 auto; display: inline-flex; align-items: center; height: 21px; padding: 0 8px; border: 1px solid; border-radius: 6px; font-family: "Cascadia Code", Consolas, monospace; font-size: 10px; }
.inline-approval-reason { margin-top: 10px; font-size: 12.2px; line-height: 1.65; }
.inline-approval-label { margin: 10px 0 4px; font-size: 10px; letter-spacing: .02em; }
.inline-approval-detail { margin: 0; padding: 8px 10px; max-height: 92px; overflow: auto; border: 1px solid; border-radius: 8px; white-space: pre-wrap; word-break: break-all; font-family: "Cascadia Code", Consolas, monospace; font-size: 10.8px; line-height: 1.55; }
.inline-approval-escalation { display: flex; align-items: flex-start; gap: 6px; margin-top: 9px; font-size: 10.5px; line-height: 1.55; }
.inline-approval-foot { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 11px; border-top: 1px solid rgba(127,127,127,.18); }
.inline-approval-hint { flex: 1; min-width: 0; font-size: 10px; line-height: 1.5; }
.inline-approval-actions { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; }
.inline-approval-btn { display: inline-flex; align-items: center; justify-content: center; line-height: 1; height: 27px; padding: 0 11px; border: 1px solid rgba(127,127,127,.35); border-radius: 7px; background: transparent; font-family: inherit; font-size: 11px; cursor: pointer; color: inherit; }
.inline-approval-btn.is-primary { background: #e9e9eb; border-color: #e9e9eb; color: #17181b; font-weight: 600; }
.inline-approval-btn.is-deny { color: #e88; border-color: rgba(240,120,120,.28); }
.inline-approval-btn:disabled { opacity: .55; cursor: default; }
`

export default PermissionApprovalPanel
