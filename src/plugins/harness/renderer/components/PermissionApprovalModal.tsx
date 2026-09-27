import React, { useState, useEffect, useRef } from 'react'
import { Modal, theme } from 'antd'
import { RiShieldKeyholeLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { ApprovalDecision, ApprovalRequestView, PermissionMode } from '../../shared/types'
import { harnessApi } from '../api'

/**
 * 沙箱审批弹窗 —— 主进程拦下一次「越界 / 危险 / 无法判定」的调用后挂起等待用户决定，
 * 渲染层收到 harness-approval-asked 弹出本窗，用户点「允许一次」或「拒绝」回写决定，
 * 那次调用才继续（或带着拒绝文本返回给模型）。
 *
 * 与提问弹窗（AskQuestionModal）的关系：形状同源（挂起 → 弹窗 → 回写 → 原轮继续），
 * 但语义不同，因此独立一个组件：
 * - **只有临时决定**（DSH 同款）：允许一次 / 拒绝，没有「总是允许」——持久策略归档位选择器；
 * - 只响应当前话题的审批；但**当前还没有话题时（新会话第一轮）也照常显示**，
 *   否则第一次危险调用会因为前端还不知道 topicId 而无人应答（闸门只能一直挂着）；
 * - 无超时（与提问一致）：点「停止生成」撤回本轮，挂起审批随之按拒绝结算。
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

  const [pending, setPending] = useState<ApprovalRequestView | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  useEffect(() => {
    const unsubscribe = harnessApi.harness.onApprovalAsked((p) => {
      // 新会话第一轮时前端还没拿到 topicId（null）——这时也必须弹，否则无人应答
      if (currentTopicIdRef.current == null || p.topicId === currentTopicIdRef.current) {
        setPending(p)
      }
    })
    return unsubscribe
  }, [])

  // 切话题：把该话题当前挂起的审批拉回来（弹窗可能在别的界面挂起，或页面刚重载）
  useEffect(() => {
    if (currentTopicId == null) {
      setPending(null)
      return
    }
    let cancelled = false
    void harnessApi.harness
      .getApproval(currentTopicId)
      .then((view) => {
        if (!cancelled) setPending(view ?? null)
      })
      .catch(() => {
        // 通道不可用（插件停用）时保持现状即可
      })
    return () => {
      cancelled = true
    }
  }, [currentTopicId])

  // 流结束 / 出错 → 收起弹窗（审批已随本轮撤回，弹窗再留着就没有意义了）
  useEffect(() => {
    const close = (payload?: { topicId?: number }): void => {
      if (
        payload &&
        typeof payload.topicId === 'number' &&
        payload.topicId !== currentTopicIdRef.current
      ) {
        return
      }
      setPending(null)
    }
    const unDone = harnessApi.harness.onStreamDone(close)
    const unErr = harnessApi.harness.onStreamError(close)
    return () => {
      unDone()
      unErr()
    }
  }, [])

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    if (!pending || submitting) return
    setSubmitting(true)
    try {
      await harnessApi.harness.decideApproval(pending.requestId, decision)
      setPending(null)
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
      maskClosable={false}
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
