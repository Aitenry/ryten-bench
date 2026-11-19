import React, { useState } from 'react'
import { Modal, theme } from 'antd'
import { RiShieldKeyholeLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { ApprovalDecision, ApprovalRequestView, PermissionMode } from '../../shared/types'
import { harnessApi } from '../api'
import { useTopicPending } from '../hooks/useTopicPending'

/**
 * 沙箱审批弹窗 —— 主进程拦下一次「越界 / 危险 / 无法判定」的调用后挂起等待用户决定，
 * 渲染层收到 harness-approval-asked 弹出本窗，用户点「允许一次」或「拒绝」回写决定，
 * 那次调用才继续（或带着拒绝文本返回给模型）。
 *
 * 与提问弹窗（AskQuestionModal）的关系：形状同源（挂起 → 弹窗 → 回写 → 原轮继续），
 * 但语义不同，因此独立一个组件：
 * - **只有临时决定**（DSH 同款）：允许一次 / 拒绝，没有「总是允许」——持久策略归档位选择器；
 * - **按会话隔离**：只显示当前这条会话挂起的审批，切到别的会话就收起、点回来再拉出来
 *   （取数逻辑见 hooks/useTopicPending；用户口径 2026-09-28「会被其他的会话占用后，授权也一样」）；
 * - 无超时（与提问一致）：点「停止生成」撤回**这一条会话**的挂起审批并按拒绝结算。
 */

/** 档位显示名的词条键（i18n 键是字面量，动态拼键过不了 t() 的类型校验） */
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

const PermissionApprovalModal: React.FC<{ currentTopicId: number | null }> = ({
  currentTopicId
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [submitting, setSubmitting] = useState(false)

  /**
   * 只显示**当前这条会话**挂起的审批（取数逻辑见 hooks/useTopicPending）。
   *
   * 用户口径 2026-09-28「一直卡住，会被其他的会话占用后，授权也一样，应该是按会话进行隔离，
   * 点击不同会话才显示弹出窗口」：此前「当前话题为 null 时也弹」那条口子会把**别的会话**的
   * 审批弹到空白会话上，用户一点就把别人的调用允许了；切话题时虽然会重拉，但重拉失败/未重拉
   * 的窗口期里弹窗还留着上一条会话的内容。
   */
  const { pending, clear: clearPending } = useTopicPending<ApprovalRequestView>({
    currentTopicId,
    fetchPending: (topicId) => harnessApi.harness.getApproval(topicId),
    subscribe: (listener) => harnessApi.harness.onApprovalAsked(listener)
  })

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    if (!pending || submitting) return
    setSubmitting(true)
    try {
      await harnessApi.harness.decideApproval(pending.requestId, decision)
      clearPending()
    } finally {
      setSubmitting(false)
    }
  }

  if (!pending) return null

  return (
    <Modal
      open
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <RiShieldKeyholeLine size={16} style={{ color: token.colorWarning }} />
          {t('harness.approval.title')}
        </span>
      }
      closable={false}
      // antd 6：maskClosable 已弃用，改用 mask.closable
      mask={{ closable: false }}
      okText={t('harness.approval.allowOnce')}
      cancelText={t('harness.approval.deny')}
      cancelButtonProps={{ disabled: submitting }}
      okButtonProps={{ loading: submitting }}
      onOk={() => void decide('allow-once')}
      onCancel={() => void decide('deny')}
      width={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
        {/* 触发原因：主进程已按界面语言渲染好（同一份词条也发给模型） */}
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>{pending.reason}</div>

        {/* 这次要做什么：命令全文 / 路径 / 参数摘要 —— 用户要能看清再决定 */}
        <div>
          <div style={{ fontSize: 11, color: token.colorTextTertiary, marginBottom: 4 }}>
            {t('harness.approval.detailLabel')}
          </div>
          <pre
            className="custom-scrollbar"
            style={{
              margin: 0,
              padding: '8px 10px',
              maxHeight: 180,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 12,
              lineHeight: 1.55,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              background: token.colorFillQuaternary,
              borderRadius: 6,
              color: token.colorText
            }}
          >
            {pending.detail}
          </pre>
        </div>

        {/* 升权重试：说清模型想临时用哪个更宽档位、理由是什么 */}
        {pending.requestedMode ? (
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {t('harness.approval.escalationNote', {
              mode: t(modeLabelKey(pending.requestedMode)),
              justification: pending.justification ?? ''
            })}
          </div>
        ) : null}

        <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
          {t('harness.approval.toolLabel')}: {pending.toolName}
        </div>
        <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
          {t('harness.approval.footerHint')}
        </div>
      </div>
    </Modal>
  )
}

export default PermissionApprovalModal
