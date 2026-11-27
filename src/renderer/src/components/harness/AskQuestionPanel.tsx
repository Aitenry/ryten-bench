import React, { useEffect, useMemo, useState } from 'react'
import { theme } from 'antd'
import { RiQuestionAnswerLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'
import type { PendingQuestionView } from '../../../../shared/harness/types'
import {
  QUESTION_OTHER_VALUE,
  buildQuestionAnswers,
  canSubmitAllQuestions,
  canSubmitQuestion,
  questionHasChoices,
  type QuestionDraft
} from '../../utils/harness/question'

/**
 * ask_user_question 的**输入区内联面板**（替代原弹窗，2026-11-27 用户口径）。
 *
 * 口径：
 * - 不再弹独立窗口：面板占据输入框位置，问题区高亮/选项居中（radio 与右侧内容垂直居中）；
 * - 提交 = 回答后本轮继续（不新开消息）；
 * - 取消 = **不终止本轮**：通知主进程按 cancelled 结算挂起问题，面板立即消失、输入恢复，
 *   模型收到「用户取消回答」后继续执行；不显示任何取消提示条；
 * - 多题时一次一题（上一题/下一题/提交），单题直接提交。
 *
 * 纯逻辑（「其他」处理、答案折叠、可提交判定）在 utils/harness/question.ts，并单独有单测。
 */

interface AskQuestionPanelProps {
  pending: PendingQuestionView
  submitting: boolean
  onSubmit: (answers: ReturnType<typeof buildQuestionAnswers>) => void
  onCancel: () => void
}

const AskQuestionPanel: React.FC<AskQuestionPanelProps> = ({
  pending,
  submitting,
  onSubmit,
  onCancel
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const questions = pending.questions
  const [step, setStep] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})

  // 换了一批问题（新 requestId）→ 回到第一题、清空草稿
  useEffect(() => {
    setStep(0)
    setDrafts({})
  }, [pending.requestId])

  const currentIndex = Math.min(step, Math.max(0, questions.length - 1))
  const question = questions[currentIndex]
  const draft = question ? drafts[question.id] : undefined
  const hasChoices = question ? questionHasChoices(question) : false
  const choseOther = Boolean(draft?.selected.includes(QUESTION_OTHER_VALUE))
  const canSubmitCurrent = question ? canSubmitQuestion(question, draft) : false
  const canSubmitAll = canSubmitAllQuestions(questions, drafts)
  const isLast = currentIndex >= questions.length - 1

  const updateDraft = (id: string, patch: Partial<QuestionDraft>): void => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { selected: prev[id]?.selected ?? [], custom: prev[id]?.custom, ...patch }
    }))
  }

  const toggleMulti = (id: string, label: string): void => {
    const current = drafts[id]?.selected ?? []
    updateDraft(id, {
      selected: current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label]
    })
  }

  const goNext = (): void => {
    if (!isLast && canSubmitCurrent) setStep((prev) => Math.min(prev + 1, questions.length - 1))
  }

  const progressText = useMemo(() => {
    if (questions.length <= 1) return t('harness.askQuestion.singleHint')
    return t('harness.askQuestion.progress', {
      current: currentIndex + 1,
      total: questions.length
    })
  }, [currentIndex, questions.length, t])

  if (!question) return null

  return (
    <div className="ask-inline-wrap" data-ask-panel="1">
      <div
        className="ask-inline"
        style={{
          borderColor: token.colorPrimaryBorder,
          background: `linear-gradient(180deg, ${token.colorPrimaryBg}, ${token.colorBgElevated} 40%)`
        }}
      >
        <div className="ask-inline-head">
          <span
            className="ask-inline-icon"
            style={{ color: token.colorPrimary, background: token.colorPrimaryBg }}
          >
            <RiQuestionAnswerLine size={15} />
          </span>
          <span className="ask-inline-title" style={{ color: token.colorText }}>
            {t('harness.askQuestion.headerTitle')}
          </span>
          <span className="ask-inline-progress" style={{ color: token.colorTextTertiary }}>
            {progressText}
          </span>
          {questions.length > 1 ? (
            <span className="ask-inline-dots" aria-hidden="true">
              {questions.map((item, index) => (
                <span
                  key={item.id}
                  className={`ask-inline-dot${index === currentIndex ? ' is-active' : ''}`}
                />
              ))}
            </span>
          ) : null}
        </div>

        <div className="ask-inline-question" style={{ color: token.colorText }} data-ask-question={question.id}>
          {question.header ? (
            <span style={{ color: token.colorTextSecondary }}>{question.header} · </span>
          ) : null}
          {question.question}
        </div>

        {hasChoices ? (
          <div className="ask-inline-options">
            {question.options!.map((option, optionIndex) => {
              const label = option.label
              const checked = draft?.selected.includes(label) ?? false
              return (
                <button
                  key={`${label}-${optionIndex}`}
                  type="button"
                  data-ask-option={label}
                  onClick={() =>
                    question.multi_select
                      ? toggleMulti(question.id, label)
                      : updateDraft(question.id, { selected: [label] })
                  }
                  className={`ask-inline-opt${checked ? ' is-selected' : ''}`}
                  style={{
                    borderColor: checked ? token.colorPrimaryBorder : token.colorBorderSecondary,
                    background: checked ? token.colorPrimaryBg : token.colorBgContainer
                  }}
                >
                  <span
                    className={`ask-inline-radio${question.multi_select ? ' is-multi' : ''}${checked ? ' is-checked' : ''}`}
                    style={{ borderColor: checked ? token.colorPrimary : token.colorBorder }}
                  />
                  <span className="ask-inline-opt-text">
                    <span style={{ color: token.colorText }}>{label}</span>
                    {option.description ? (
                      <span style={{ color: token.colorTextTertiary }}>{option.description}</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              data-ask-option={QUESTION_OTHER_VALUE}
              onClick={() =>
                question.multi_select
                  ? toggleMulti(question.id, QUESTION_OTHER_VALUE)
                  : updateDraft(question.id, { selected: [QUESTION_OTHER_VALUE] })
              }
              className={`ask-inline-opt${choseOther ? ' is-selected' : ''}`}
              style={{
                borderColor: choseOther ? token.colorPrimaryBorder : token.colorBorderSecondary,
                background: choseOther ? token.colorPrimaryBg : token.colorBgContainer
              }}
            >
              <span
                className={`ask-inline-radio${question.multi_select ? ' is-multi' : ''}${choseOther ? ' is-checked' : ''}`}
                style={{ borderColor: choseOther ? token.colorPrimary : token.colorBorder }}
              />
              <span className="ask-inline-opt-text">
                <span style={{ color: token.colorText }}>
                  {t('harness.askQuestion.otherOption')}
                </span>
              </span>
            </button>
            {choseOther ? (
              <textarea
                data-ask-custom="1"
                autoFocus
                rows={2}
                placeholder={t('harness.askQuestion.customPlaceholder')}
                value={draft?.custom ?? ''}
                onChange={(event) => updateDraft(question.id, { custom: event.target.value })}
                className="custom-scrollbar"
                style={{
                  borderColor: token.colorBorderSecondary,
                  color: token.colorText,
                  background: token.colorBgContainer
                }}
              />
            ) : null}
          </div>
        ) : (
          <textarea
            data-ask-custom="1"
            autoFocus
            rows={2}
            placeholder={t('harness.askQuestion.customPlaceholder')}
            value={draft?.custom ?? ''}
            onChange={(event) => updateDraft(question.id, { custom: event.target.value })}
            className="custom-scrollbar"
            style={{
              borderColor: token.colorBorderSecondary,
              color: token.colorText,
              background: token.colorBgContainer
            }}
          />
        )}

        <div className="ask-inline-foot" style={{ borderTopColor: token.colorBorderSecondary }}>
          <button
            type="button"
            className="ask-inline-btn is-plain"
            data-ask-cancel="1"
            disabled={submitting}
            onClick={onCancel}
            title={t('harness.askQuestion.cancelHint')}
          >
            {t('harness.askQuestion.cancelText')}
          </button>
          <span className="ask-inline-hint" style={{ color: token.colorTextTertiary }}>
            {canSubmitCurrent ? t('harness.askQuestion.cancelHint') : t('harness.askQuestion.required')}
          </span>
          <span className="ask-inline-actions">
            {currentIndex > 0 ? (
              <button
                type="button"
                className="ask-inline-btn"
                data-ask-prev="1"
                disabled={submitting}
                onClick={() => setStep((prev) => Math.max(0, prev - 1))}
              >
                {t('harness.askQuestion.prev')}
              </button>
            ) : null}
            {isLast ? (
              <button
                type="button"
                className="ask-inline-btn is-primary"
                data-ask-submit="1"
                disabled={submitting || !canSubmitAll}
                onClick={() => onSubmit(buildQuestionAnswers(questions, drafts))}
              >
                {t('harness.askQuestion.okText')}
              </button>
            ) : (
              <button
                type="button"
                className="ask-inline-btn is-primary"
                data-ask-next="1"
                disabled={submitting || !canSubmitCurrent}
                onClick={goNext}
              >
                {t('harness.askQuestion.next')}
              </button>
            )}
          </span>
        </div>
      </div>
      <style>{askInlineStyles}</style>
    </div>
  )
}

const askInlineStyles = `
.ask-inline-wrap { position: relative; }
.ask-inline { display: flex; flex-direction: column; border: 1px solid; border-radius: 16px; padding: 13px 15px 12px; box-shadow: 0 12px 30px rgba(77,107,254,.08); }
.ask-inline-head { display: flex; align-items: center; gap: 8px; }
.ask-inline-icon { width: 26px; height: 26px; border-radius: 9px; display: grid; place-items: center; flex: 0 0 auto; }
.ask-inline-title { font-size: 13px; font-weight: 600; }
.ask-inline-progress { font-size: 10.5px; }
.ask-inline-dots { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; }
.ask-inline-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(127,127,127,.28); }
.ask-inline-dot.is-active { width: 14px; border-radius: 4px; background: #4d6bfe; }
.ask-inline-question { margin-top: 10px; font-size: 12.5px; font-weight: 500; line-height: 1.6; }
.ask-inline-options { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.ask-inline-opt { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; border: 1px solid; border-radius: 10px; padding: 8px 11px; cursor: pointer; font: inherit; }
.ask-inline-opt:hover { opacity: .92; }
.ask-inline-radio { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid; flex: 0 0 auto; position: relative; }
.ask-inline-radio.is-multi { border-radius: 4px; }
.ask-inline-radio.is-checked::after { content: ""; position: absolute; inset: 2.5px; border-radius: inherit; background: #4d6bfe; }
.ask-inline-opt-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ask-inline-opt-text > span:first-child { font-size: 12px; }
.ask-inline-opt-text > span:last-child:not(:first-child) { font-size: 10.5px; }
.ask-inline-options textarea { width: 100%; resize: vertical; min-height: 54px; border: 1px solid; border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12px; line-height: 1.55; outline: none; }
.ask-inline-wrap > .ask-inline > textarea { width: 100%; margin-top: 8px; resize: vertical; min-height: 54px; border: 1px solid; border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12px; line-height: 1.55; outline: none; }
.ask-inline-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding-top: 9px; border-top: 1px solid; }
.ask-inline-hint { flex: 1; min-width: 0; font-size: 10px; line-height: 1.5; }
.ask-inline-actions { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; }
.ask-inline-btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid rgba(127,127,127,.35); background: transparent; font-family: inherit; font-size: 11.5px; cursor: pointer; color: inherit; }
.ask-inline-btn.is-primary { background: #1f2329; border-color: #1f2329; color: #fff; font-weight: 600; }
.ask-inline-btn.is-plain { color: #595f6b; }
.ask-inline-btn:disabled { opacity: .5; cursor: default; }
`

export default AskQuestionPanel
