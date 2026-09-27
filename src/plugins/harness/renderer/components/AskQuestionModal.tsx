import React, { useState, useEffect, useRef } from 'react'
import { Modal, Radio, Checkbox, Input, theme } from 'antd'
import { RiQuestionAnswerLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { PendingQuestionView } from '../../shared/types'
import { harnessApi } from '../api'

/**
 * 提问弹窗（ask_user_question）— 模型执行 ask_user_question 工具时挂起等待，
 * 主进程广播 harness-question-asked；本组件弹出表单收集答案并回写，流在原轮内继续。
 *
 * - 只响应当前话题的提问（topicId 匹配）；
 * - 单选（Radio）/ 多选（Checkbox）/ 自由文本（Input → custom）；
 * - 无跳过按钮（DSH 语义：无超时、必须回答）；用户点「停止生成」中止整条流，
 *   挂起提问随之取消（主进程 questionService.abortAll），本组件在 done/error 时收起；
 * - 提交 → harnessApi.harness.answerQuestion(requestId, answers) → 主进程回写 → 模型继续。
 */

interface AnswerDraft {
  selected: string[]
  custom?: string
}

const AskQuestionModal: React.FC<{ currentTopicId: number | null }> = ({ currentTopicId }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [pending, setPending] = useState<PendingQuestionView | null>(null)
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({})
  const [submitting, setSubmitting] = useState(false)

  const currentTopicIdRef = useRef(currentTopicId)
  currentTopicIdRef.current = currentTopicId

  useEffect(() => {
    const unsubscribe = harnessApi.harness.onQuestionAsked((p) => {
      // 「换模型继续」由专用 ModelRecoveryModal 处理，通用提问弹窗忽略，避免重复弹窗
      if (p.questions.some((q) => q.kind === 'model-recovery')) return
      if (p.topicId === currentTopicIdRef.current) {
        setPending(p)
        setDrafts({})
      }
    })
    return unsubscribe
  }, [])

  // 流结束/出错 → 收起弹窗（提问已取消或已无意义）
  useEffect(() => {
    const close = (payload?: { topicId?: number }): void => {
      // 只响应当前话题的流结束（修复：此前任意话题 done/error 都会误关当前话题挂起的
      // 提问——如后台目标自动续跑流结束,弹窗被误关而主进程提问仍挂起）
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
