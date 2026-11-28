import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, theme } from 'antd'
import { RiCalendarTodoLine, RiCheckLine, RiCloseLine, RiEditLine } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { PendingQuestionView } from '../../../../shared/harness/types'
import {
  PLAN_REVIEW_APPROVE,
  PLAN_REVIEW_KEEP_PLANNING,
  PLAN_REVIEW_KIND
} from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'
import { useTopicPending } from '../../hooks/harness/useTopicPending'
import MarkdownLoad from '../markdown/MarkdownLoad'

/**
 * Plan area (inline) — above the input box.
 *
 * Replaces the old "plan mode badge on the input + PlanReviewModal":
 * - while plan mode is on, a lightweight status row is shown (exiting is inline as well);
 * - once the model submits a plan through exit_plan_mode, the review card expands right below
 *   the status row: Markdown plan + in-place pencil editing + feedback + approve / keep planning;
 * - everything sits above the input box: no modal, no input space taken.
 */
interface InlinePlanTrayProps {
  currentTopicId: number | null
  /** Counter bumped by the slash command / external entry to toggle plan mode */
  toggleSignal: number
  /** Cancel this turn (the same path as the input's stop) */
  onCancelTurn: () => void
  /** Plan review pending state changes: the page locks goal actions and the input accordingly */
  onReviewPendingChange?: (pending: boolean) => void
  isDarkMode: boolean
}

const InlinePlanTray: React.FC<InlinePlanTrayProps> = ({
  currentTopicId,
  toggleSignal,
  onCancelTurn,
  onReviewPendingChange,
  isDarkMode
}) => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()

  const [planActive, setPlanActive] = useState(false)
  const [planSaving, setPlanSaving] = useState(false)
  const lastToggleSignalRef = useRef(toggleSignal)

  const fetchPending = useCallback((topicId: number) => harnessApi.harness.getQuestion(topicId), [])
  const subscribe = useCallback(
    (listener: (pending: PendingQuestionView) => void) =>
      harnessApi.harness.onQuestionAsked(listener),
    []
  )
  const accept = useCallback(
    (pending: PendingQuestionView) =>
      pending.questions.some((question) => question.kind === PLAN_REVIEW_KIND),
    []
  )
  const { pending, clear: clearPending } = useTopicPending<PendingQuestionView>({
    currentTopicId,
    fetchPending,
    subscribe,
    accept
  })
  const question = pending?.questions.find((item) => item.kind === PLAN_REVIEW_KIND)

  useEffect(() => {
    onReviewPendingChange?.(Boolean(question))
  }, [onReviewPendingChange, question])

  const [editingPlan, setEditingPlan] = useState(false)
  const [draftPlan, setDraftPlan] = useState('')
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const planTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setPlanActive(false)
    if (currentTopicId == null) return
    let cancelled = false
    void harnessApi.harness
      .getPlanMode(currentTopicId)
      .then((view) => {
        if (!cancelled) setPlanActive(view.active)
      })
      .catch(() => {})
    const unsubscribe = harnessApi.harness.onPlanModeUpdated((view) => {
      if (view.topicId === currentTopicId) setPlanActive(view.active)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [currentTopicId])

  // A different review arrived: reset the draft
  useEffect(() => {
    if (!question) {
      setEditingPlan(false)
      setDraftPlan('')
      setFeedback('')
      return
    }
    setDraftPlan(question.question)
    setFeedback('')
    setEditingPlan(false)
  }, [pending?.requestId, question])

  useEffect(() => {
    if (!editingPlan) return
    const el = planTextareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editingPlan])

  const togglePlanMode = useCallback(
    async (active: boolean): Promise<void> => {
      if (currentTopicId == null) {
        message.info(t('harness.input.commands.noTopic'))
        return
      }
      setPlanSaving(true)
      try {
        const view = await harnessApi.harness.setPlanMode({ topicId: currentTopicId, active })
        setPlanActive(view.active)
        message.success(
          view.active ? t('harness.planMode.enabled') : t('harness.planMode.disabled')
        )
      } catch (err) {
        message.error(t('harness.planMode.switchFailed'))
        console.warn('[plan-tray] Failed to switch plan mode:', err)
      } finally {
        setPlanSaving(false)
      }
    },
    [currentTopicId, message, t]
  )

  useEffect(() => {
    if (toggleSignal === lastToggleSignalRef.current) return
    lastToggleSignalRef.current = toggleSignal
    void togglePlanMode(!planActive)
    // planActive is deliberately not a dependency: fire once per signal change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleSignal, togglePlanMode])

  const edited = question ? draftPlan.trim() !== question.question.trim() : false
  const customFeedback = useMemo(() => {
    const parts: string[] = []
    if (edited) parts.push(`修订后的计划：\n${draftPlan.trim()}`)
    if (feedback.trim()) parts.push(feedback.trim())
    return parts.join('\n\n')
  }, [draftPlan, edited, feedback])

  const submit = useCallback(
    async (approved: boolean): Promise<void> => {
      if (!pending || !question || submitting) return
      setSubmitting(true)
      try {
        // Approved: the final plan text becomes the goal directly; the plan card then goes away and
        // the goal starts running.
        if (approved && currentTopicId != null) {
          const objective = (draftPlan.trim() || question.question.trim()).slice(0, 8000)
          const existing = await harnessApi.harness.getGoal(currentTopicId).catch(() => null)
          const result =
            existing && existing.phase !== 'complete'
              ? await harnessApi.harness.updateGoal({
                  topicId: currentTopicId,
                  action: 'edit',
                  objective
                })
              : await harnessApi.harness.createGoal({ topicId: currentTopicId, objective })
          if (!result.ok) {
            message.error(result.error ?? t('harness.goalInline.saveFailed'))
            return
          }
        }
        await harnessApi.harness.answerQuestion(pending.requestId, [
          {
            id: question.id,
            selected: [approved ? PLAN_REVIEW_APPROVE : PLAN_REVIEW_KEEP_PLANNING],
            custom: customFeedback || undefined
          }
        ])
        clearPending()
        setEditingPlan(false)
        setFeedback('')
      } catch (err) {
        message.error((err as Error).message)
      } finally {
        setSubmitting(false)
      }
    },
    [
      clearPending,
      currentTopicId,
      customFeedback,
      draftPlan,
      message,
      pending,
      question,
      submitting,
      t
    ]
  )

  const cancelTurn = useCallback((): void => {
    if (submitting) return
    clearPending()
    onCancelTurn()
  }, [clearPending, onCancelTurn, submitting])

  if (currentTopicId == null) return null

  return (
    <>
      {planActive && !question ? (
        <div
          className="inline-plan-row"
          style={{ borderColor: token.colorBorderSecondary, background: token.colorFillQuaternary }}
        >
          <span
            className="inline-plan-tag"
            style={{ color: token.colorPrimary, background: token.colorPrimaryBg }}
          >
            <RiCalendarTodoLine size={12} />
            {t('harness.planInline.tag')}
          </span>
          <span className="inline-plan-row-text" style={{ color: token.colorTextSecondary }}>
            {t('harness.planInline.activeHint')}
          </span>
          <button
            type="button"
            className="inline-plan-icon"
            disabled={planSaving}
            onClick={() => void togglePlanMode(false)}
            title={t('harness.planInline.exit')}
            style={{ color: token.colorTextTertiary }}
          >
            <RiCloseLine size={14} />
          </button>
        </div>
      ) : null}

      {question ? (
        <div
          className="inline-plan-card"
          style={{ borderColor: token.colorBorderSecondary, background: token.colorFillQuaternary }}
        >
          <div className="inline-plan-head">
            <span
              className="inline-plan-tag"
              style={{ color: token.colorPrimary, background: token.colorPrimaryBg }}
            >
              <RiCalendarTodoLine size={12} />
              {t('harness.planInline.tag')}
            </span>
            <span className="inline-plan-title" style={{ color: token.colorText }}>
              {question.header || t('harness.planReview.title')}
            </span>
            <span
              className="inline-plan-state"
              style={{ color: token.colorWarning, borderColor: token.colorWarningBorder }}
            >
              {t('harness.planInline.waiting')}
            </span>
            <span className="inline-plan-head-actions">
              {editingPlan ? (
                <span style={{ color: token.colorTextTertiary, fontSize: 10.5 }}>
                  <span
                    className="inline-plan-kbd"
                    style={{ borderColor: token.colorBorderSecondary }}
                  >
                    Enter
                  </span>{' '}
                  {t('harness.planInline.save')} <span className="inline-plan-sep">·</span>{' '}
                  <span
                    className="inline-plan-kbd"
                    style={{ borderColor: token.colorBorderSecondary }}
                  >
                    Esc
                  </span>{' '}
                  {t('harness.planInline.cancel')}
                </span>
              ) : null}
              <button
                type="button"
                className="inline-plan-icon"
                title={t('harness.planInline.editPlan')}
                onClick={() => setEditingPlan((value) => !value)}
                style={{ color: token.colorTextSecondary }}
              >
                {editingPlan ? <RiCheckLine size={14} /> : <RiEditLine size={14} />}
              </button>
            </span>
          </div>

          {editingPlan ? (
            <div className="inline-plan-edit">
              <textarea
                ref={planTextareaRef}
                value={draftPlan}
                onChange={(event) => setDraftPlan(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setDraftPlan(question.question)
                    setEditingPlan(false)
                    return
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    setEditingPlan(false)
                  }
                }}
                rows={8}
                style={{ color: token.colorText, background: 'transparent' }}
              />
              <div className="inline-plan-edit-foot">
                <button
                  type="button"
                  className="inline-plan-btn"
                  onClick={() => setEditingPlan(false)}
                >
                  {t('harness.planInline.cancel')}
                </button>
                <button
                  type="button"
                  className="inline-plan-btn is-primary"
                  onClick={() => setEditingPlan(false)}
                >
                  {t('harness.planInline.savePlan')}
                </button>
              </div>
            </div>
          ) : (
            <div
              className="custom-scrollbar inline-plan-markdown"
              style={{ borderColor: token.colorBorderSecondary }}
            >
              <MarkdownLoad
                content={draftPlan || question.question || t('harness.planReview.emptyPlan')}
                isDarkMode={isDarkMode}
              />
            </div>
          )}

          <input
            className="inline-plan-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={t('harness.planInline.feedbackPlaceholder')}
            disabled={submitting || editingPlan}
            style={{ color: token.colorText, borderColor: token.colorBorderSecondary }}
          />

          <div className="inline-plan-foot">
            <button
              type="button"
              className="inline-plan-btn is-danger"
              disabled={submitting}
              onClick={cancelTurn}
            >
              {t('harness.askQuestion.cancelText')}
            </button>
            <span className="inline-plan-foot-note" style={{ color: token.colorTextTertiary }}>
              {edited ? t('harness.planInline.editedNote') : t('harness.planReview.hint')}
            </span>
            <span className="inline-plan-foot-actions">
              <button
                type="button"
                className="inline-plan-btn"
                disabled={submitting || editingPlan}
                onClick={() => void submit(false)}
              >
                {t('harness.planReview.keepPlanning')}
              </button>
              <button
                type="button"
                className="inline-plan-btn is-primary"
                disabled={submitting || editingPlan}
                onClick={() => void submit(true)}
              >
                {t('harness.planReview.approve')}
              </button>
            </span>
          </div>
        </div>
      ) : null}
      <style>{planStyles}</style>
    </>
  )
}

const planStyles = `
.inline-plan-row { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; min-height: 32px; padding: 6px 8px 6px 11px; border: 1px solid; border-radius: 11px; font-size: 11.5px; }
.inline-plan-row-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inline-plan-tag { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 7px; font-size: 10.5px; font-weight: 600; white-space: nowrap; line-height: 1; flex: 0 0 auto; }
.inline-plan-icon { width: 24px; height: 24px; border: 0; border-radius: 7px; background: transparent; display: grid; place-items: center; cursor: pointer; padding: 0; }
.inline-plan-icon:hover { background: rgba(127,127,127,.14); }
.inline-plan-card { display: flex; flex-direction: column; border: 1px solid; border-radius: 14px; overflow: hidden; margin-bottom: 8px; }
.inline-plan-head { display: flex; align-items: center; gap: 8px; padding: 10px 11px 8px; }
.inline-plan-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; }
.inline-plan-state { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; height: 19px; padding: 0 7px; border: 1px solid; border-radius: 6px; font-size: 10px; white-space: nowrap; line-height: 1; }
.inline-plan-head-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.inline-plan-kbd { display: inline-flex; align-items: center; justify-content: center; line-height: 1; height: 15px; padding: 0 4px; border: 1px solid; border-radius: 4px; font-size: 9px; }
.inline-plan-sep { opacity: .55; margin: 0 2px; }
.inline-plan-markdown { max-height: 340px; overflow-y: auto; margin: 0 11px; padding: 10px 12px; border: 1px solid; border-radius: 9px; background: rgba(127,127,127,.035); font-size: 12.5px; line-height: 1.7; }
.inline-plan-markdown .markdown-body { font-size: 12.5px; line-height: 1.7; }
.inline-plan-markdown .markdown-body > :first-child { margin-top: 0; }
.inline-plan-markdown .markdown-body > :last-child { margin-bottom: 0; }
.inline-plan-markdown .markdown-body h1 { font-size: 16px; }
.inline-plan-markdown .markdown-body h2 { font-size: 14px; }
.inline-plan-markdown .markdown-body h3, .inline-plan-markdown .markdown-body h4 { font-size: 13px; }
.inline-plan-edit { margin: 0 11px; border: 1px solid; border-radius: 9px; padding: 9px 11px; border-color: rgba(127,127,127,.22); }
.inline-plan-edit textarea { width: 100%; border: 0; outline: none; resize: vertical; padding: 0; font-family: "Cascadia Code", Consolas, monospace; font-size: 11.5px; line-height: 1.7; }
.inline-plan-edit-foot { display: flex; justify-content: flex-end; gap: 6px; margin-top: 7px; }
.inline-plan-feedback { margin: 9px 11px 0; height: 32px; padding: 0 10px; line-height: 1.2; border: 1px solid; border-radius: 8px; background: transparent; outline: none; font-family: inherit; font-size: 11.5px; }
.inline-plan-foot { display: flex; align-items: center; gap: 8px; padding: 9px 11px 11px; }
.inline-plan-foot-note { flex: 1; min-width: 0; font-size: 10px; }
.inline-plan-foot-actions { display: inline-flex; align-items: center; gap: 6px; }
.inline-plan-btn { display: inline-flex; align-items: center; justify-content: center; line-height: 1; height: 26px; padding: 0 10px; border: 1px solid rgba(127,127,127,.35); border-radius: 7px; background: transparent; font-family: inherit; font-size: 10.5px; cursor: pointer; color: inherit; }
.inline-plan-btn.is-primary { background: #e9e9eb; border-color: #e9e9eb; color: #17181b; font-weight: 600; }
.inline-plan-btn.is-danger { color: #e88; border-color: rgba(240,120,120,.28); }
.inline-plan-btn:disabled { opacity: .5; cursor: default; }
`

export default InlinePlanTray
