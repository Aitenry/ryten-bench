import React, { useState, useEffect } from 'react'
import { Modal, Radio, Checkbox, Input, theme } from 'antd'
import { RiQuestionAnswerLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { PendingQuestionView } from '../../shared/types'
import { harnessApi } from '../api'
import { useTopicPending } from '../hooks/useTopicPending'

/**
 * 提问弹窗（ask_user_question）— 模型执行 ask_user_question 工具时挂起等待，
 * 主进程广播 harness-question-asked；本组件弹出表单收集答案并回写，流在原轮内继续。
 *
 * **按会话隔离**（用户口径 2026-09-28「一直卡住，会被其他的会话占用……点击不同会话才显示
 * 弹出窗口」）：只显示**当前这条会话**挂起的提问，切到别的会话就收起、点回来再拉出来
 * （取数逻辑见 hooks/useTopicPending）。
 *
 * - 单选（Radio）/ 多选（Checkbox）/ 自由文本（Input → custom）；
 * - 无跳过按钮（DSH 语义：无超时、必须回答）；用户点「停止生成」中止整条流，
 *   挂起提问随之取消（主进程 questionService.abortTopic），本组件在 done/error 时收起；
 * - 提交 → harnessApi.harness.answerQuestion(requestId, answers) → 主进程回写 → 模型继续。
 */

interface AnswerDraft {
  selected: string[]
  custom?: string
}

const AskQuestionModal: React.FC<{ currentTopicId: number | null }> = ({ currentTopicId }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({})
  const [submitting, setSubmitting] = useState(false)

  const { pending, clear: clearPending } = useTopicPending<PendingQuestionView>({
    currentTopicId,
    fetchPending: (topicId) => harnessApi.harness.getQuestion(topicId),
    subscribe: (listener) => harnessApi.harness.onQuestionAsked(listener),
    // 「换模型继续」由专用 ModelRecoveryModal 处理，通用提问弹窗忽略，避免重复弹窗
    accept: (p) => !p.questions.some((q) => q.kind === 'model-recovery')
  })

  // 换了一条提问就清空草稿（同一张表单不该带着上一条的答案）
  useEffect(() => {
    setDrafts({})
  }, [pending?.requestId])

  const updateDraft = (id: string, patch: Partial<AnswerDraft>): void => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { selected: prev[id]?.selected ?? [], custom: prev[id]?.custom, ...patch }
    }))
  }

  const canSubmit = (): boolean => {
    if (!pending) return false
    return pending.questions.every((q) => {
      const d = drafts[q.id]
      const hasSelection = (d?.selected.length ?? 0) > 0
      const hasCustom = Boolean(d?.custom && d.custom.trim())
      return hasSelection || hasCustom
    })
  }

  const handleSubmit = async (): Promise<void> => {
    if (!pending || submitting) return
    setSubmitting(true)
    try {
      const answers = pending.questions.map((q) => ({
        id: q.id,
        selected: drafts[q.id]?.selected ?? [],
        custom: drafts[q.id]?.custom?.trim() || undefined
      }))
      await harnessApi.harness.answerQuestion(pending.requestId, answers)
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
          <RiQuestionAnswerLine size={16} style={{ color: token.colorPrimary }} />
          {t('harness.askQuestion.title')}
        </span>
      }
      closable={false}
      // antd 6：maskClosable 已弃用，改用 mask.closable
      mask={{ closable: false }}
      okText={t('harness.askQuestion.okText')}
      cancelButtonProps={{ style: { display: 'none' } }}
      okButtonProps={{ disabled: !canSubmit(), loading: submitting }}
      onOk={() => void handleSubmit()}
      width={520}
      styles={{ body: { maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }}
      classNames={{ body: 'custom-scrollbar' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 4 }}>
        {pending.questions.map((q, qi) => {
          const draft = drafts[q.id]
          return (
            <div key={q.id}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {q.header && <span style={{ color: token.colorTextSecondary }}>{q.header} · </span>}
                {qi + 1}. {q.question}
              </div>
              {q.options && q.options.length > 0 ? (
                q.multi_select ? (
                  <Checkbox.Group
                    value={draft?.selected ?? []}
                    onChange={(values) => updateDraft(q.id, { selected: values as string[] })}
                    style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                  >
                    {q.options.map((opt, oi) => (
                      <Checkbox key={oi} value={opt.label}>
                        <span style={{ fontSize: 13 }}>{opt.label}</span>
                        {opt.description && (
                          <span style={{ fontSize: 12, color: token.colorTextTertiary }}>
                            {' '}
                            — {opt.description}
                          </span>
                        )}
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                ) : (
                  <Radio.Group
                    value={draft?.selected?.[0]}
                    onChange={(e) => updateDraft(q.id, { selected: [e.target.value as string] })}
                    style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                  >
                    {q.options.map((opt, oi) => (
                      <Radio key={oi} value={opt.label}>
                        <span style={{ fontSize: 13 }}>{opt.label}</span>
                        {opt.description && (
                          <span style={{ fontSize: 12, color: token.colorTextTertiary }}>
                            {' '}
                            — {opt.description}
                          </span>
                        )}
                      </Radio>
                    ))}
                  </Radio.Group>
                )
              ) : (
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  placeholder={t('harness.askQuestion.customPlaceholder')}
                  value={draft?.custom ?? ''}
                  onChange={(e) => updateDraft(q.id, { custom: e.target.value })}
                />
              )}
              {!q.options && draft?.selected?.[0] && null}
            </div>
          )
        })}
        <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
          {t('harness.askQuestion.footerHint')}
        </div>
      </div>
    </Modal>
  )
}

export default AskQuestionModal
