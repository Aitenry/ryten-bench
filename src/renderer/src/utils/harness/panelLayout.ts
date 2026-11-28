/**
 * Width policy for the three columns of the assistant page (topic list / conversation /
 * workspace panel).
 *
 * Why it was extracted: these numbers used to be scattered across inline styles and a few
 * computations in Index.tsx, and having **two sources of truth** for one thing always drifts —
 * on 2026-09-24 the conversation column's lower bound was raised from 410 to 420 only in the
 * JSX `minWidth` while the computation still used 410, so when dragged to the maximum the panel
 * was 10px wider than the row could hold and got silently clipped by
 * `.harness-layout { overflow: hidden }` (user feedback 2026-09-25: "on the largest screen the
 * file editor can't be dragged wider, the conversation can only be pushed to 420").
 * Now all widths are taken from here, so one change applies globally.
 */

/** Minimum width of the conversation column. It is the **last fallback**: the panel/topic-bar maxima are computed around it */
export const MAIN_MIN_WIDTH = 420

/** Width of a column resizer (the left and right ones are equally wide) */
export const RESIZER_WIDTH = 6

/** Workspace panel: it must not get narrower than this when a file is open (editor visible), or the editor is left with just a sliver */
export const PANEL_MIN_WITH_EDITOR = 450

/** Workspace panel: with no file open it only holds the file tree, so keep it a fixed narrow column */
export const PANEL_MIN_WITHOUT_EDITOR = 220

/** Auto-expand width ratio for the panel when a file is opened (no longer applied once the user has dragged it) */
export const PANEL_AUTO_OPEN_RATIO = 0.35

/**
 * The panel's maximum share of the chat area widens with the available width: 45% in a small
 * window, up to 65% on a large screen.
 *
 * Why a fixed 45% doesn't work: the ratio cap is reached before the "conversation minimum", so
 * the bigger the screen the less the minimum gets a say — in a 1920 window the panel was capped
 * at 838px while the conversation still left 784px empty, making the editor impossible to drag
 * wider on large screens. The 45%→65% linear range goes from layoutWidth 1200 (near the minimum
 * window) to 2400 (wide screens).
 */
const RATIO_MIN_LAYOUT_WIDTH = 1200
const RATIO_MAX_LAYOUT_WIDTH = 2400
const RATIO_AT_MIN_LAYOUT_WIDTH = 0.45
const RATIO_AT_MAX_LAYOUT_WIDTH = 0.65

/** Panel ratio cap for the current available width */
export const panelMaxRatio = (layoutWidth: number): number => {
  const progress = Math.min(
    1,
    Math.max(
      0,
      (layoutWidth - RATIO_MIN_LAYOUT_WIDTH) / (RATIO_MAX_LAYOUT_WIDTH - RATIO_MIN_LAYOUT_WIDTH)
    )
  )
  return (
    RATIO_AT_MIN_LAYOUT_WIDTH + (RATIO_AT_MAX_LAYOUT_WIDTH - RATIO_AT_MIN_LAYOUT_WIDTH) * progress
  )
}

/** Lower width bound of the workspace panel (wider once a file is open) */
export const panelMinWidthFor = (hasEditor: boolean): number =>
  hasEditor ? PANEL_MIN_WITH_EDITOR : PANEL_MIN_WITHOUT_EDITOR

/**
 * Upper width bound of the workspace panel: the smaller of the ratio cap and "conversation keeps
 * at least MAIN_MIN_WIDTH".
 *
 * Invariant: `topic bar + resizer + conversation + resizer + panel <= layoutWidth` (the row does
 * not overflow → nothing gets clipped). In extremely narrow windows the
 * `Math.max(PANEL_MIN_WITH_EDITOR, ...)` fallback deliberately breaks it: at that point it is
 * more important that the editor isn't a sliver (the panel element's minWidth pushes the same
 * way), at the cost of the overflowing row being clipped by `overflow: hidden`.
 */
export const computePanelMaxWidth = (input: {
  layoutWidth: number
  hasEditor: boolean
  sidebarOpen: boolean
  sidebarWidth: number
}): number => {
  const { layoutWidth, hasEditor, sidebarOpen, sidebarWidth } = input
  if (!hasEditor) return PANEL_MIN_WITHOUT_EDITOR
  return Math.max(
    PANEL_MIN_WITH_EDITOR,
    Math.min(
      Math.floor(layoutWidth * panelMaxRatio(layoutWidth)),
      layoutWidth -
        (sidebarOpen ? sidebarWidth + RESIZER_WIDTH : 0) -
        RESIZER_WIDTH -
        MAIN_MIN_WIDTH
    )
  )
}

/**
 * Width range of the topic bar (left side).
 * The maximum must match the CSS `maxWidth` of the topic column in Index.tsx: when the two
 * disagree, the state can be dragged past the CSS cap while the element stops there, leaving a
 * dead zone at the end of the drag where "the pointer moves but the layout doesn't" (it used to
 * be 260 vs 239).
 */
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 239

/** Upper width bound of the topic bar (left side): it also has to leave enough room for the conversation and the workspace panel */
export const computeSidebarMaxWidth = (input: {
  layoutWidth: number
  panelOpen: boolean
  panelWidth: number
}): number => {
  const { layoutWidth, panelOpen, panelWidth } = input
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      layoutWidth - RESIZER_WIDTH - MAIN_MIN_WIDTH - (panelOpen ? panelWidth + RESIZER_WIDTH : 0)
    )
  )
}

/** Width convergence after a drag / window resize: first clamp into the [min, max] range */
export const clampWidth = (width: number, minWidth: number, maxWidth: number): number =>
  Math.min(Math.max(width, minWidth), maxWidth)

/** Auto-expanded panel width when a file is opened (clamped to the upper bound) */
export const autoOpenPanelWidth = (layoutWidth: number, maxWidth: number): number =>
  Math.min(Math.floor(layoutWidth * PANEL_AUTO_OPEN_RATIO), maxWidth)
