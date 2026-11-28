import React from 'react'
import { RiArrowLeftSLine, RiArrowRightSLine, RiFlag2Line } from '@remixicon/react'
import { useTranslation } from '@renderer/i18n'

/**
 * Batch banner for automatic goal-continuation rounds: a centered dashed row showing "round N/M"
 * plus the goal objective, with left/right navigation when there are multiple rounds.
 *
 * Both constraints come from user feedback on 2026-09-19:
 *  ① "This content causes a scrollbar in narrow windows — optimize the layout" — the banner must
 *     **never widen its container at any width**: outer min-width:0, banner max-width:100% +
 *     min-width:0 + overflow:hidden; apart from the 13px flag and the nav buttons, all text can
 *     shrink and is truncated with an ellipsis (single line);
 *  ② "Merge these AI reply rounds within the same batch and switch them with left/right clicks" —
 *     round switching lives here: ‹ › sit right after the label, always visible (never shrink),
 *     and unselected rounds are **not mounted** by the caller.
 */
export interface GoalRoundBannerProps {
  /** Current round (1-based, position within the batch) */
  current: number
  /** Total rounds in the batch; omit when this banner does not belong to a multi-round batch (no left/right navigation) */
  total?: number
  /** Goal objective (shrinkable, single-line ellipsis) */
  objective: string
  colorTextSecondary: string
  colorBorderSecondary: string
  /** Previous round (clickable only when current > 1) */
  onPrev?: () => void
  /** Next round (clickable only when current < total) */
  onNext?: () => void
}

/** Single-line shrinkable text: min-width 0 is required for ellipsis truncation (flex items default to min-width:auto and will not shrink below their content) */
const shrinkable: React.CSSProperties = {
  minWidth: 0,
  flex: '0 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/**
 * Goal objective: shrinks with much higher priority than the "round N/M" label (shrink weight 100 : 1).
 * Otherwise, in a narrow window the two shrinkable items would share compression by content size and
 * the label would be squeezed into "G…" — losing the round information. The full objective is also
 * available in the GoalBar above the input box, so let it shrink first here.
 */
const objectiveStyle: React.CSSProperties = {
  ...shrinkable,
  flex: '0 100 auto'
}

const NavButton: React.FC<{
  disabled: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}> = ({ disabled, title, onClick, children }) => (
  <button
    type="button"
    data-goal-nav
    disabled={disabled}
    title={title}
    aria-label={title}
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      lineHeight: 0,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.3 : 1,
      flex: '0 0 auto'
    }}
  >
    {children}
  </button>
)

const GoalRoundBanner: React.FC<GoalRoundBannerProps> = ({
  current,
  total,
  objective,
  colorTextSecondary,
  colorBorderSecondary,
  onPrev,
  onNext
}) => {
  const { t } = useTranslation()
  const totalRounds = total ?? 1
  const navigable = totalRounds > 1 && Boolean(onPrev || onNext)

  return (
    <>
      {/* min-width:0 / max-width:100%: let the single centered row shrink as a whole in a narrow
          container and never be wider than the parent (otherwise the flex item would widen the
          parent by its min-content width → horizontal scrollbar) */}
      <div className="flex justify-center mb-4" style={{ minWidth: 0, maxWidth: '100%' }}>
        <div
          data-goal-banner
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            borderRadius: 12,
            border: `1px dashed ${colorBorderSecondary}`,
            color: colorTextSecondary,
            fontSize: 12,
            maxWidth: '100%',
            minWidth: 0,
            overflow: 'hidden'
          }}
        >
          <RiFlag2Line size={13} style={{ flex: '0 0 auto' }} />
          {/* The round label does not shrink: it is the banner's main information (the full
              objective is in the GoalBar). `text-overflow: ellipsis` triggers even at 1px of
              overflow, so making the label shrinkable would let the objective squeeze one
              character out of it. */}
          <span style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>
            {t('harness.userMessage.goalRound', {
              round: navigable ? `${current}/${totalRounds}` : current
            })}
          </span>
          {navigable ? (
            <span style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
              <NavButton
                disabled={current <= 1}
                title={t('harness.userMessage.goalPrev')}
                onClick={() => onPrev?.()}
              >
                <RiArrowLeftSLine size={16} />
              </NavButton>
              <NavButton
                disabled={current >= totalRounds}
                title={t('harness.userMessage.goalNext')}
                onClick={() => onNext?.()}
              >
                <RiArrowRightSLine size={16} />
              </NavButton>
            </span>
          ) : null}
          {objective ? (
            <>
              <span style={{ opacity: 0.75, flex: '0 0 auto' }}>—</span>
              <span data-goal-objective style={objectiveStyle} title={objective}>
                {objective}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}

export default GoalRoundBanner
