import React, { useCallback, useEffect, useState } from 'react'
import { App, Dropdown, theme, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { RiEditLine, RiFlag2Line, RiMore2Fill } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

import type { GoalView } from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'

/**
 * Goal card (inline) — the first layer above the input box.
 *
 * Editing the objective text does not expand inside the card; it reuses the chat input below:
 * - clicking the pencil / `/goal` switches the input into "goal input" mode;
 * - the goal bar is then highlighted and its status reads "editing"; with no goal a "new goal"
 *   hint row is shown instead;
 * - pressing Enter in the input saves the objective and immediately starts a round.
 */
interface InlineGoalCardProps {
  currentTopicId: number | null
  /** Whether the goal input is selected (goal bar highlighted, status switched to editing) */
  selected?: boolean
  /** Lock goal actions while a plan review is pending */
  disabled?: boolean
  /** Edit click: hand the current objective text to the main input */
  onRequestEdit: (objective: string) => void
}

const phaseLabelKeys = {
  active: 'harness.goalBar.phaseActive',
  paused: 'harness.goalBar.phasePaused',
  blocked: 'harness.goalBar.phaseBlocked',
  complete: 'harness.goalBar.phaseComplete'
} as const

const InlineGoalCard: React.FC<InlineGoalCardProps> = ({
  currentTopicId,
  selected = false,
  disabled = false,
  onRequestEdit
}) => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()

  const [goal, setGoal] = useState<GoalView | null>(null)

  useEffect(() => {
    setGoal(null)
    if (currentTopicId == null) return
    let cancelled = false
    const topicId = currentTopicId
    void harnessApi.harness
      .getGoal(topicId)
      .then((next) => {
        if (!cancelled) setGoal(next)
      })
      .catch(() => {})
    const unsubscribe = harnessApi.harness.onGoalUpdated((data) => {
      if (data.topicId === topicId) setGoal(data.goal)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [currentTopicId])

  const runGoalAction = useCallback(
    async (action: 'pause' | 'resume' | 'complete' | 'clear'): Promise<void> => {
      if (currentTopicId == null) return
      try {
        if (action === 'clear') {
          const result = await harnessApi.harness.clearGoal(currentTopicId)
          if (!result.ok) {
            message.error(result.error ?? t('harness.goalInline.actionFailed'))
            return
          }
          setGoal(null)
        } else {
          const result = await harnessApi.harness.updateGoal({ topicId: currentTopicId, action })
          if (!result.ok) {
            message.error(result.error ?? t('harness.goalInline.actionFailed'))
            return
          }
          setGoal(result.goal ?? null)
        }
      } catch (err) {
        message.error(t('harness.goalInline.actionFailed') + (err as Error).message)
      }
    },
    [currentTopicId, message, t]
  )

  const menuItems = ((): MenuProps['items'] => {
    if (!goal) return []
    const items: MenuProps['items'] = []
    if (goal.phase === 'active') {
      items.push({ key: 'pause', label: t('harness.goalDialog.pause') })
    } else if (goal.phase === 'paused' || goal.phase === 'blocked') {
      items.push({ key: 'resume', label: t('harness.goalDialog.resume') })
    }
    if (goal.phase !== 'complete') {
      items.push({ key: 'complete', label: t('harness.goalDialog.complete') })
    }
    items.push({ type: 'divider' })
    items.push({ key: 'clear', label: t('harness.goalDialog.clear'), danger: true })
    return items
  })()

  if (currentTopicId == null) return null

  if (!goal) {
    if (!selected) return null
    return (
      <div
        className="inline-goal-empty-target"
        style={{ borderColor: token.colorPrimaryBorder, background: token.colorPrimaryBg }}
      >
        <span
          className="inline-goal-tag"
          style={{ color: token.colorPrimary, background: token.colorPrimaryBg }}
        >
          <RiFlag2Line size={13} />
          {t('harness.goalInline.newTarget')}
        </span>
        <span className="inline-goal-text" style={{ color: token.colorTextSecondary }}>
          {t('harness.goalInline.newTargetHint')}
        </span>
        <style>{goalStyles}</style>
      </div>
    )
  }

  // A finished goal leaves the input stack: after `complete` the record is kept in the database
  // (it can be reviewed / replaced via `/goal`), but a done goal must not keep occupying the
  // composer area. It is still rendered while selected so `/goal` can show the finished objective
  // and prefill the input for a new one.
  if (goal.phase === 'complete' && !selected) return null

  const phaseColor =
    goal.phase === 'active'
      ? token.colorPrimary
      : goal.phase === 'blocked'
        ? token.colorWarning
        : token.colorTextTertiary
  const blockedTitle = goal.blockedReason
    ? t('harness.goalBar.blocked', {
        code: goal.blockedReason.code,
        message: goal.blockedReason.message
      })
    : undefined

  return (
    <div
      className={`inline-goal${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
      style={{
        borderColor: selected ? token.colorPrimaryBorder : token.colorBorderSecondary,
        background: token.colorFillQuaternary,
        boxShadow: selected ? `0 0 0 3px ${token.colorPrimaryBg}` : undefined
      }}
    >
      <span
        className="inline-goal-tag"
        style={{ color: token.colorPrimary, background: token.colorPrimaryBg }}
      >
        <RiFlag2Line size={13} />
        {t('harness.goalInline.tag')}
      </span>
      <span className="inline-goal-text" style={{ color: token.colorText }} title={goal.objective}>
        {goal.objective}
      </span>
      <span className="inline-goal-side">
        {goal.roundsStarted > 0 ? (
          <span
            className="inline-goal-rounds"
            style={{ color: token.colorTextTertiary, borderColor: token.colorBorderSecondary }}
          >
            {t('harness.goalInline.rounds', { rounds: goal.roundsStarted })}
          </span>
        ) : null}
        {selected ? (
          <span
            className="inline-goal-status"
            style={{ color: token.colorPrimary, borderColor: token.colorPrimaryBorder }}
          >
            {t('harness.goalInline.editing')}
          </span>
        ) : (
          <>
            <Tooltip title={blockedTitle}>
              <span
                className="inline-goal-status"
                style={{
                  color: goal.phase === 'blocked' ? token.colorWarning : phaseColor,
                  borderColor: phaseColor
                }}
              >
                {t(phaseLabelKeys[goal.phase])}
              </span>
            </Tooltip>
            <Tooltip title={t('harness.goalInline.editTitle')}>
              <button
                type="button"
                className="inline-goal-icon"
                onClick={() => onRequestEdit(goal.objective)}
                style={{ color: token.colorTextSecondary }}
              >
                <RiEditLine size={14} />
              </button>
            </Tooltip>
            <Dropdown
              trigger={['click']}
              menu={{
                items: menuItems,
                onClick: ({ key }) => {
                  if (
                    key === 'pause' ||
                    key === 'resume' ||
                    key === 'complete' ||
                    key === 'clear'
                  ) {
                    void runGoalAction(key)
                  }
                }
              }}
            >
              <button
                type="button"
                className="inline-goal-icon"
                style={{ color: token.colorTextTertiary }}
              >
                <RiMore2Fill size={14} />
              </button>
            </Dropdown>
          </>
        )}
      </span>
      <style>{goalStyles}</style>
    </div>
  )
}

const goalStyles = `
.inline-goal { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; min-height: 38px; padding: 0 7px 0 10px; border: 1px solid; border-radius: 12px; transition: border-color .18s ease, box-shadow .18s ease, background .18s ease; }
.inline-goal-tag { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 23px; padding: 0 8px; border-radius: 7px; font-size: 11px; font-weight: 600; flex: 0 0 auto; white-space: nowrap; line-height: 1; }
.inline-goal-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.8px; line-height: 1.45; }
.inline-goal-side { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.inline-goal-rounds { display: inline-flex; align-items: center; justify-content: center; height: 19px; padding: 0 7px; border: 1px solid; border-radius: 6px; font-size: 10px; white-space: nowrap; line-height: 1; flex: 0 0 auto; }
.inline-goal-status { display: inline-flex; align-items: center; justify-content: center; height: 19px; padding: 0 7px; border: 1px solid; border-radius: 6px; font-size: 10px; white-space: nowrap; line-height: 1; flex: 0 0 auto; }
.inline-goal-icon { width: 24px; height: 24px; border: 0; border-radius: 7px; background: transparent; display: grid; place-items: center; cursor: pointer; padding: 0; }
.inline-goal-icon:hover { background: rgba(127,127,127,.14); }
.inline-goal.is-disabled { opacity: .55; pointer-events: none; }
.inline-goal.is-selected { border-color: rgba(96,165,250,.62) !important; background: linear-gradient(180deg, rgba(77,141,255,.085), rgba(77,141,255,.018)); box-shadow: 0 0 0 3px rgba(77,141,255,.08); }
.inline-goal-empty-target { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; min-height: 38px; padding: 0 9px 0 10px; border: 1px dashed; border-radius: 12px; }
.inline-goal-empty-hint { margin-left: auto; font-size: 10.5px; white-space: nowrap; }
`

export default InlineGoalCard
