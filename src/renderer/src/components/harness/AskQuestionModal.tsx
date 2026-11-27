import React, { useState, useEffect } from 'react'
import { Modal, Radio, Checkbox, Input, theme } from 'antd'
import { RiQuestionAnswerLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { PendingQuestionView } from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'
import { useTopicPending } from '../../hooks/harness/useTopicPending'

/**
 * 提问弹窗（ask_user_question）— 模型执行 ask_user_question 工具时挂起等待，
 * 主进程广播 harness-question-asked；本组件弹出表单收集答案并回写，流在原轮内继续。
 *
 * **按会话隔离**（用户口径 2026-09-28「一直卡住，会被其他的会话占用……点击不同会话才显示
 * 弹出窗口」）：只显示**当前这条会话**挂起的提问，切到别的会话就收起、点回来再拉出来
 * （取数逻辑见 hooks/useTopicPending）。
 *
 * - 单选（Radio）/ 多选（Checkbox）/ 自由文本（Input → custom）；
 * - 选择式提问**末尾固定补一项「其他」**：选中后出现输入框，自填内容走 custom，
 *   伪选项不写进 selected（模型拿到 [{selected:[], custom:"…"}]，不会以为「其他」是它给的选项）；
 * - 无跳过（DSH 语义：无超时、必须回答）；弹窗挡住输入框的「停止生成」，所以自带一个
 *   「取消」按钮走同一条中止路径（onCancelTurn → cancelStream → questionService.abortTopic），
 *   挂起提问随之取消，本组件在 done/error 时收起；
 * - 提交 → harnessApi.harness.answerQuestion(requestId, answers) → 主进程回写 → 模型继续。
 */

interface AnswerDraft {
  selected: string[]
  custom?: string
}

/**
 * 「其他」伪选项的哨兵值。
 *
 * 模型的选项是 label 字符串，而「其他」不是模型给的选项，只活在表单里：
 * 选中它 → 下面出现输入框；提交时把它从 selected 里剥掉，输入的内容放进 `custom`
 * （与 DSH 的「custom 覆盖/补充 selected」一致，模型拿到的是 [{selected:[], custom:"…"}]）。
 * 用控制字符开头，避免和真实选项 label 撞名。
 */
const OTHER_VALUE = '\u0000ask-other'

/** 选择式提问（有 options）才补「其他」；纯文本提问本身就是自由输入 */
const hasChoices = (q: PendingQuestionView['questions'][number]): boolean =>
  Boolean(q.options && q.options.length > 0)

const AskQuestionModal: React.FC<{
  currentTopicId: number | null
  /**
   * 「取消」按钮：与输入框的「停止生成」同一个动作（中止本轮并拒绝挂起的提问）。
   *
   * 弹窗盖住了输入框，用户在等回答时点不到「停止生成」；只留「提交回答」等于逼用户
   * 在四个选项里选一个（用户口径 2026-11-24「没有取消按钮」）。这里把停止动作搬进弹窗。
   */
  onCancelTurn: () => void
}> = ({ currentTopicId, onCancelTurn }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({})
  const [submitting, setSubmitting] = useState(false)

  const { pending, clear: clearPending } = useTopicPending<PendingQuestionView>({
    currentTopicId,
    fetchPending: (topicId) => harnessApi.harness.getQuestion(topicId),
    subscribe: (listener) => harnessApi.harness.onQuestionAsked(listener),
    // 「换模型继续」由专用 ModelRecoveryModal 处理、「计划评审」由 PlanReviewModal 处理，
    // 通用提问弹窗忽略这两类，避免同一挂起项被两个弹窗抢着渲染
    accept: (p) =>
      !p.questions.some(
        (q) => q.kind === 'model-recovery' || q.kind === 'plan-review'
      )
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
      const selected = d?.selected ?? []
      const hasCustom = Boolean(d?.custom && d.custom.trim())
      if (hasChoices(q)) {
        // 选了「其他」就必须把内容填上，否则这个答案没有信息量
        return selected.includes(OTHER_VALUE) ? hasCustom : selected.length > 0
      }
      return hasCustom
    })
  }

  const handleSubmit = async (): Promise<void> => {
    if (!pending || submitting) return
    setSubmitting(true)
    try {
      const answers = pending.questions.map((q) => {
        const draft = drafts[q.id]
        const selected = draft?.selected ?? []
        const choseOther = hasChoices(q) && selected.includes(OTHER_VALUE)
        return {
          id: q.id,
          // 「其他」是表单伪选项，不进答案；自填内容走 custom
          selected: selected.filter((value) => value !== OTHER_VALUE),
          custom:
            !hasChoices(q) || choseOther ? draft?.custom?.trim() || undefined : undefined
        }
      })
      await harnessApi.harness.answerQuestion(pending.requestId, answers)
      clearPending()
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * 取消提问 = 中止本轮（与「停止生成」同一条路径，主进程 cancelStream 会拒绝挂起的提问）。
   * 先收起弹窗再中止：abort 之后主进程不再广播这条提问，留着弹窗会让人以为还在等回答。
   */
  const handleCancel = (): void => {
    if (!pending || submitting) return
    clearPending()
    onCancelTurn()
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
      // Esc 不当中止：取消本轮不可撤销，只认显式点「取消」，避免误触把整轮生成掐掉
      keyboard={false}
      okText={t('harness.askQuestion.okText')}
      cancelText={t('harness.askQuestion.cancelText')}
      cancelButtonProps={{ disabled: submitting }}
      okButtonProps={{ disabled: !canSubmit(), loading: submitting }}
      onOk={() => void handleSubmit()}
      onCancel={handleCancel}
      width={520}
      styles={{ body: { maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }}
      classNames={{ body: 'custom-scrollbar app-modal-scroll' }}
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
              {hasChoices(q) ? (
                <>
                  {q.multi_select ? (
                    <Checkbox.Group
                      value={draft?.selected ?? []}
                      onChange={(values) => updateDraft(q.id, { selected: values as string[] })}
                      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                    >
                      {q.options!.map((opt, oi) => (
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
                      {/* 默认补一项「其他」：模型的选项列不全时，用户不必被迫选一个近似项 */}
                      <Checkbox value={OTHER_VALUE}>
                        <span style={{ fontSize: 13 }}>
                          {t('harness.askQuestion.otherOption')}
                        </span>
                      </Checkbox>
                    </Checkbox.Group>
                  ) : (
                    <Radio.Group
                      value={draft?.selected?.[0]}
                      onChange={(e) => updateDraft(q.id, { selected: [e.target.value as string] })}
                      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                    >
                      {q.options!.map((opt, oi) => (
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
                      <Radio value={OTHER_VALUE}>
                        <span style={{ fontSize: 13 }}>
                          {t('harness.askQuestion.otherOption')}
                        </span>
                      </Radio>
                    </Radio.Group>
                  )}
                  {draft?.selected.includes(OTHER_VALUE) ? (
                    <Input.TextArea
                      /* 选中「其他」就把手放到输入框里：少一次点击，也提示这里要填内容 */
                      autoFocus
                      autoSize={{ minRows: 2, maxRows: 4 }}
                      placeholder={t('harness.askQuestion.customPlaceholder')}
                      value={draft?.custom ?? ''}
                      onChange={(e) => updateDraft(q.id, { custom: e.target.value })}
                      style={{ marginTop: 8 }}
                    />
                  ) : null}
                </>
              ) : (
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  placeholder={t('harness.askQuestion.customPlaceholder')}
                  value={draft?.custom ?? ''}
                  onChange={(e) => updateDraft(q.id, { custom: e.target.value })}
                />
              )}
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
