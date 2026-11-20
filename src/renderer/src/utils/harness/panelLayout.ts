/**
 * 助手页三栏（话题列表 / 对话 / 工作区面板）的宽度策略。
 *
 * 抽出来的原因：这些数字原来散在 Index.tsx 内联样式与几处计算里，
 * 同一件事有**两个真源**就必然漂移——2026-09-24 把对话列的下限从 410 提到 420 时
 * 只改了 JSX 的 `minWidth`，计算里仍是 410，于是拖到上限时面板比整行能容纳的宽 10px，
 * 被 `.harness-layout { overflow: hidden }` 无声裁掉（用户 2026-09-25 反馈
 * 「最大屏下文件编辑器拖不动宽，只能把对话顶到 420」）。
 * 现在所有宽度都从这里取值，改一处即全局生效。
 */

/** 对话列的最小宽度。它是**最后的兜底**：面板/话题栏的上限都围着它算 */
export const MAIN_MIN_WIDTH = 420

/** 分栏拖拽条宽度（左右两根都一样宽） */
export const RESIZER_WIDTH = 6

/** 工作区面板：打开文件（显示编辑器）时不能比这更窄，否则编辑器只剩一条缝 */
export const PANEL_MIN_WITH_EDITOR = 450

/** 工作区面板：没打开文件时只有文件树，固定窄栏 */
export const PANEL_MIN_WITHOUT_EDITOR = 220

/** 打开文件时面板的自动展开宽度比例（用户自己拖过之后不再套用） */
export const PANEL_AUTO_OPEN_RATIO = 0.35

/**
 * 面板占聊天区的比例上限随可用宽度放开：小窗口 45%，大屏最多 65%。
 *
 * 为什么不能固定 45%：比例上限比「对话下限」先到，屏幕越大越轮不到下限说话——
 * 1920 窗口下面板最多 838px、对话还留着 784px 空着，用户在大屏上根本拖不动编辑器。
 * 45%→65% 的线性区间取 layoutWidth 1200（最小窗口附近）到 2400（宽屏）。
 */
const RATIO_MIN_LAYOUT_WIDTH = 1200
const RATIO_MAX_LAYOUT_WIDTH = 2400
const RATIO_AT_MIN_LAYOUT_WIDTH = 0.45
const RATIO_AT_MAX_LAYOUT_WIDTH = 0.65

/** 当前可用宽度对应的面板比例上限 */
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

/** 工作区面板的宽度下限（打开文件后要求更宽） */
export const panelMinWidthFor = (hasEditor: boolean): number =>
  hasEditor ? PANEL_MIN_WITH_EDITOR : PANEL_MIN_WITHOUT_EDITOR

/**
 * 工作区面板的宽度上限：比例上限与「对话至少 MAIN_MIN_WIDTH」取小。
 *
 * 不变量：`话题栏 + 分隔条 + 对话 + 分隔条 + 面板 <= layoutWidth`（行内不溢出 → 不会被裁）。
 * 极端窄的窗口下 `Math.max(PANEL_MIN_WITH_EDITOR, ...)` 的兜底会主动打破它：此时优先保证
 * 编辑器不是一条缝（面板元素的 minWidth 同样顶着），代价是整行溢出被 `overflow: hidden` 裁掉。
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
 * 话题栏（左侧）的宽度范围。
 * 上限必须与 Index.tsx 里话题列的 CSS `maxWidth` 一致：两处不一致时状态能拖到更大的值、
 * 元素却停在 CSS 上限，拖拽末尾就有一段「指针在动、布局不动」的死区（原来是 260 vs 239）。
 */
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 239

/** 话题栏（左侧）的宽度上限：同样要留够对话区与工作区面板 */
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

/** 拖拽 / 窗口变化后的宽度收敛：先夹进「下限~上限」区间 */
export const clampWidth = (width: number, minWidth: number, maxWidth: number): number =>
  Math.min(Math.max(width, minWidth), maxWidth)

/** 打开文件时面板的自动展开宽度（夹在上限之内） */
export const autoOpenPanelWidth = (layoutWidth: number, maxWidth: number): number =>
  Math.min(Math.floor(layoutWidth * PANEL_AUTO_OPEN_RATIO), maxWidth)
