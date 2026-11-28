import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Table, theme as antdTheme, type ModalProps, type TableProps } from 'antd'
import { useTheme } from '@host/renderer/hooks/useTheme'

/**
 * Layout and color primitives: **the shared foundation of plugin UIs**; pages and components take
 * them from here instead of each writing their own.
 *
 * Why the template ships this file: the height chain of the host page container is
 * `custom-frame-outer(100vh) → custom-frame(overflow:hidden,flex-col) → frame-body(flex-1,min-h-0)
 * → .frame-body-center(flex-1,overflow:auto,min-h-0, plugin pages mount here)`,
 * so a plugin root node using `h-full` gets a **definite height**.
 * Every primitive below has one goal: **plugin pages never show a scrollbar**; when content grows
 * they degrade by available height.
 */

export interface Size {
  width: number
  height: number
}

/** Observe the element's own size (ResizeObserver): charts and adaptive containers use it to turn "available height" into pixels */
export function useSize<T extends HTMLElement = HTMLDivElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

/** Palette: neutral colors come from antd tokens, semantic colors are provided for both themes */
export interface PluginPalette {
  /** Whether the current theme is dark */
  dark: boolean
  /** Accent color (emphasis other than primary buttons, main chart lines) */
  accent: string
  /** Positive / normal (success, rising) */
  up: string
  /** Negative / danger (failure, falling) */
  down: string
  /** Warning (approaching a limit, pending) */
  warn: string
  /** Border (cards, table outer frame) */
  border: string
  /** Divider / chart grid line (lighter than the border) */
  split: string
  /** Soft background (tinted panels such as metric blocks) */
  soft: string
  /** Track background (unfilled part of a progress bar) */
  track: string
  /** Axis / secondary hint text */
  axis: string
  /** Primary text (text that needs an explicit color in charts) */
  text: string
  /** Panel background (used to mask graphical elements, e.g. a line endpoint dot) */
  surface: string
}

/**
 * Light semantic colors: each is one step darker so that text on the panel background keeps a
 * contrast ratio >= 3:1; small numbers then do not look washed out (`#16a34a` is only 3.4 on white,
 * while `#15803d` is 4.9).
 */
const LIGHT_SEMANTIC = {
  accent: '#8b5cf6',
  up: '#15803d',
  down: '#ef4444',
  warn: '#f59e0b'
}

/** Dark semantic colors: bright without blowing out on dark backgrounds (antd colorSuccess/colorError do not contrast enough for small text) */
const DARK_SEMANTIC = {
  accent: '#a78bfa',
  up: '#4ade80',
  down: '#f87171',
  warn: '#fbbf24'
}

/**
 * UI palette: **components never contain literal color values**; take everything from here.
 *
 * Why the Tailwind `dark:` variant cannot be used (a real incident: users reported "dark theme not
 * supported"): the workshop compiles `plugin.css` with `tailwindcss/theme + utilities`, without
 * `@custom-variant dark`, so `dark:bg-x` lands as **`@media (prefers-color-scheme: dark)`** (driven
 * by the OS color scheme); the host switches themes via the `.dark` class on
 * `document.documentElement` plus antd `darkAlgorithm` (theme mode also supports switching by time,
 * independent of the OS scheme). The two do not line up:
 * app dark + OS light = the plugin still draws light; app light + OS dark = the plugin draws dark.
 *
 * So:
 * - **neutral colors come from antd tokens** (`theme.useToken()`) - computed by `darkAlgorithm`,
 *   following the theme;
 * - **semantic colors come in light/dark pairs**, and darkness is decided by the host `useTheme()`'s
 *   `effectiveTheme` (**same source** as the antd algorithm and the `.dark` class, so the three can
 *   never disagree);
 * - when a background variation is needed, use a **neutral translucent** color (see `HOVER_BG`),
 *   which works on any theme background.
 */
export function usePluginPalette(): PluginPalette {
  const { token } = antdTheme.useToken()
  const { effectiveTheme } = useTheme()
  const dark = effectiveTheme === 'dark'
  const semantic = dark ? DARK_SEMANTIC : LIGHT_SEMANTIC

  return {
    dark,
    ...semantic,
    border: token.colorBorderSecondary,
    split: token.colorSplit,
    // Tokens' soft backgrounds are too bright in dark mode; use a lighter hand-tuned value for the dark look
    soft: dark ? 'rgba(255, 255, 255, 0.04)' : token.colorFillQuaternary,
    track: token.colorFillSecondary,
    axis: token.colorTextTertiary,
    text: token.colorText,
    surface: token.colorBgContainer
  }
}

/**
 * Hover / selected background: **neutral translucent**, which holds on any theme background
 * (the host's own sidebar does the same). A fixed light grey becomes a bright patch in dark mode.
 */
export const HOVER_BG = 'rgba(128, 128, 128, 0.12)'

/** Hoverable row: neutral translucent background (the common shell for list rows and menu items) */
export function HoverRow(props: {
  children: React.ReactNode
  className?: string
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div
      className={'flex items-center gap-2 rounded-md px-2 py-1.5 ' + (props.className ?? '')}
      style={{ cursor: props.onClick ? 'pointer' : undefined }}
      onClick={props.onClick}
      onMouseEnter={(event) => {
        event.currentTarget.style.backgroundColor = HOVER_BG
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      {props.children}
    </div>
  )
}

/**
 * Height cap for form modals: **title and buttons fixed, body scrolls on its own**.
 *
 * Why it is mandatory (a real incident: users reported "modal height must be limited, otherwise the
 * whole page gets a scrollbar"): a content-sized modal has no upper bound - a form with 10 fields is
 * about 620px of body, plus header/footer and antd's default `top: 100px` gives 737px in total. A
 * slightly short window (1200x660) cannot fit it, and then the element that scrolls is
 * `.ant-modal-wrap` (`position: fixed; overflow: auto`, **filling the whole viewport**): a "whole
 * page" scrollbar appears at the right edge and scrolls the entire dialog - the title and Save scroll
 * out of view together, and the button often ends up off-screen.
 *
 * Approach: give the modal's white panel a `max-height` and make it a column flex container with a
 * `shrink-0` header/footer and a `flex:1 / min-height:0 / overflow:auto` body, so all squeezed space
 * goes to the body. Do **not** hard-code `max-height: calc(100vh - Npx)` on the body: header and
 * footer heights change with title lines, font size and language, and as soon as the fixed N is too
 * small the wrap scrollbar comes back; a flex chain follows the container without budgeting.
 *
 * Naming note: in antd 6 the white panel is called **`container`** (`.ant-modal-container`; in v5 it
 * was `content`/`.ant-modal-content`). Writing `styles.content` is rejected by TS (TS2353).
 *
 * Usage: `<Modal {...formModalProps} open={...}>`; display-only modals with few fields use
 * `createModalProps` (it only sets top, no internal scrolling needed). **Every Modal spreads at
 * least one of them.**
 */
export const formModalProps: Pick<ModalProps, 'style' | 'styles'> = {
  style: { top: 24, paddingBottom: 24 },
  styles: {
    container: {
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 'calc(100vh - 72px)',
      minHeight: 0
    },
    header: { flexShrink: 0 },
    body: { flex: 1, minHeight: 0, overflow: 'auto' },
    footer: { flexShrink: 0 }
  }
}

/** Short modals with constant content (confirm dialogs, info dialogs): only cap top, the rest is antd's */
export const createModalProps: Pick<ModalProps, 'style'> = { style: { top: 24 } }

/**
 * The correct way to make antd 6 Tabs fill the height (**both pitfalls are here**):
 *
 * 1. every tab is **its own `.ant-tabs-content`** (the old `.ant-tabs-content-holder` structure is
 *    gone), and antd keeps **visited** tabs in the DOM. So writing `flex:1` on `styles.content`
 *    makes those panes share the height - with 6 visited tabs the active one is only 1/6 high and
 *    its content gets clipped. `position:absolute; inset:0` is correct (every pane fills the body,
 *    only the active one is visible);
 * 2. **never write `display` in `styles.content`**: antd hides inactive tabs through the **class
 *    selector** `.ant-tabs-content-hidden`, and inline styles have higher priority, so once
 *    `display:flex` is written the hiding stops working and all visited tabs are drawn absolutely
 *    stacked at the same time (symptom: "content all crammed together"). Column layout inside a tab
 *    is left to Pane (`h-full` plus its own flex).
 *
 * Usage: `<Tabs {...pageTabsProps} items={...} />`, with `min-h-0 flex-1` on the outer element.
 */
export const pageTabsProps = {
  className: 'min-h-0 flex-1',
  tabBarStyle: { marginBottom: 10 },
  styles: {
    body: {
      position: 'relative' as const,
      display: 'flex',
      flexDirection: 'column' as const,
      height: '100%',
      minHeight: 0
    },
    content: {
      position: 'absolute' as const,
      inset: 0,
      minHeight: 0,
      overflow: 'hidden' as const
    }
  }
}

/**
 * Page shell: fills the height given by the host and **does not scroll itself**.
 *
 * The root node **must never carry `overflow-auto`** (the most common mistake): it scrolls the title
 * and tabs out of the window, which is the "whole page scrollbar" users see. If something inside a
 * page needs to scroll, add `min-h-0 flex-1 overflow-y-auto` to that one content block only.
 *
 * `scroll` is the escape hatch: turn it on explicitly when a page-level scrollbar is really needed
 * (the header still stays fixed).
 */
export function PageShell(props: {
  header?: React.ReactNode
  children: React.ReactNode
  /** Whether the content area scrolls itself (default false: the page is locked to the window and content adapts to the height) */
  scroll?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={'flex h-full min-h-0 w-full flex-col overflow-hidden px-5 pb-3 pt-4 ' + (props.className ?? '')}
    >
      {props.header ? <div className="shrink-0 pb-2">{props.header}</div> : null}
      {props.scroll ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{props.children}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      )}
    </div>
  )
}

/** Page header: title + right-side actions, always on one line, never scrolls with the content */
export function PageHeader(props: {
  title: React.ReactNode
  extra?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">{props.title}</span>
      {props.extra ? <div className="flex items-center gap-2">{props.extra}</div> : null}
    </div>
  )
}

/** Tab content area: fills the pane (a pane is absolute + inset:0, so h-full is enough) */
export function Pane(props: { children: React.ReactNode }): React.JSX.Element {
  return <div className="h-full w-full min-h-0 overflow-hidden">{props.children}</div>
}

/**
 * Panel: a card that fills the remaining height and never scrolls itself (fixed title bar, the body
 * distributes the remaining space).
 *
 * Use Card's `styles.root/header/body` to wire the internal structure into a flex column - the
 * default Card sizes itself by content, which breaks the grid row it sits in.
 */
export function Panel(props: {
  title?: React.ReactNode
  extra?: React.ReactNode
  children: React.ReactNode
  /** Whether the body scrolls itself (default false: put adaptive primitives in the body) */
  bodyScroll?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <Card
      size="small"
      variant="outlined"
      className={props.className}
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
      styles={{
        root: { display: 'flex', flexDirection: 'column', minHeight: 0 },
        header: { minHeight: 36, padding: '0 14px', fontSize: 13, fontWeight: 600 },
        body: {
          flex: 1,
          minHeight: 0,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          overflow: props.bodyScroll ? 'auto' : 'hidden'
        }
      }}
      title={props.title}
      extra={props.extra}
    >
      {props.children}
    </Card>
  )
}

/**
 * Settings page group card: **the first half of the settings page primitives**.
 *
 * Why group with Card: the settings page is hosted by the host settings dialog, right next to the
 * host's own settings; spreading every field into one long list looks unfinished and forces users to
 * scan from top to bottom to find a group. The card header names what the group controls ("List",
 * "Notifications", "Rates") and the body uses 14px padding with 14px between fields, matching the
 * look of built-in plugins.
 *
 * With little content, **use a single card**; do not force a second one just to fill the space.
 */
export function SettingsCard(props: {
  title?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Card
      size="small"
      variant="outlined"
      className={props.className}
      title={props.title}
      styles={{
        header: { minHeight: 42, padding: '0 16px', fontSize: 13, fontWeight: 600 },
        body: { padding: '14px 16px' }
      }}
    >
      <div className="flex flex-col gap-3.5">{props.children}</div>
    </Card>
  )
}

/**
 * One settings field row: **the second half of the settings page primitives** (label on the left,
 * control on the right, hint on the line below).
 *
 * Three conventions (built-in plugins all follow them):
 * 1. one field per row, the control right-aligned with `shrink-0` - scanning a row horizontally
 *    shows the current value of each item;
 * 2. extra information goes on the **11px grey line below the label** (`opacity-60` works in both
 *    light and dark themes); do not add a separate "current value: ..." block and do not merge the
 *    hint into the label;
 * 3. hints describe "what it affects" ("only affects the list display, records are not deleted"),
 *    not implementation details - users do not need to know which mount point renders this page.
 */
export function SettingRow(props: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-[24px] items-center justify-between gap-4">
        <span className="text-[13px]">{props.label}</span>
        <div className="flex shrink-0 items-center">{props.children}</div>
      </div>
      {props.hint ? <div className="text-[11px] opacity-60">{props.hint}</div> : null}
    </div>
  )
}

/** Empty state: a single centered grey line (same as the host empty state; no paragraph, no button) */
export function EmptyHint(props: { text: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <span className="text-xs" style={{ color: 'var(--rb-hint, rgba(128,128,128,0.85))' }}>
        {props.text}
      </span>
    </div>
  )
}

/**
 * Adaptive table: computes capacity from the **container's available height** and never shows a
 * vertical scrollbar. Semantics match antd Table (`table` is passed straight through).
 *
 * Two hard rules (both learned the hard way):
 * 1. **do not use a "measure the remainder -> add/remove a row" convergence loop**: layout often
 *    settles after the effect (fonts, the table's own one-off layout), so the effect measures a
 *    remainder of 0 and does nothing, while 650ms later it has actually overflowed by 18~54px. This
 *    instead "measures part heights (header / row / paginator) -> computes capacity once": capacity
 *    is a pure function of `f(container height, header, row height, paginator height)` and does not
 *    depend on how many rows are currently drawn, so it needs no convergence and does not jitter;
 * 2. **`pagination={false}` means "no pagination" = draw every row** (measured: 3 rows of 156px in
 *    a 115px box, clipped by 41px). To "draw fewer rows" you must `dataSource.slice(0, rows)`
 *    yourself (as below).
 *
 * Cell content always gets `min-w-0` + ellipsis as a fallback: once any column sets
 * `ellipsis: true` the table switches to `table-layout: fixed`, columns without a `width` only get
 * the remaining width, and `td` overflow is visible - content wider than the column **overlaps the
 * next column** (it is not clipped).
 */
export function FitTable<T extends object>(props: {
  table: TableProps<T>
  /** Used only for the initial estimate; the real row height is measured at runtime */
  rowHeight?: number
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [boxHeight, setBoxHeight] = useState(0)
  const [rows, setRows] = useState(1)
  const [pager, setPager] = useState(true)
  const [tooSmall, setTooSmall] = useState(false)
  // Measured part heights (header / row / paginator including margins); when the table is not
  // drawn, reuse the last measured values, otherwise the "degraded" check sees height as 0 because
  // nothing is drawn right now and flips back and forth.
  const headRef = useRef(40)
  const rowRef = useRef(props.rowHeight ?? 40)
  const pagerRef = useRef(56)
  const dataLength = props.table.dataSource?.length ?? 0

  useEffect(() => {
    const element = boxRef.current
    if (!element) return
    const update = (): void => setBoxHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const measure = useCallback((): void => {
    const element = boxRef.current
    if (!element) return
    const thead = element.querySelector('.ant-table-thead')
    const firstRow = element.querySelector('.ant-table-tbody tr')
    const pagination = element.querySelector('.ant-pagination')
    if (thead instanceof HTMLElement) headRef.current = thead.offsetHeight
    if (firstRow instanceof HTMLElement) rowRef.current = firstRow.offsetHeight
    if (pagination instanceof HTMLElement) {
      const style = getComputedStyle(pagination)
      pagerRef.current =
        pagination.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
    }
    const available = element.clientHeight
    if (available <= 0) return
    // Not even "header + one row" fits: do not draw the table (it would certainly be clipped); let
    // the caller's fallback hint show
    if (available < headRef.current + rowRef.current) {
      setTooSmall(true)
      return
    }
    setTooSmall(false)
    const withPager = Math.floor((available - headRef.current - pagerRef.current) / rowRef.current)
    const withoutPager = Math.floor((available - headRef.current) / rowRef.current)
    const capacity = withPager >= 1 ? withPager : withoutPager
    setPager(withPager >= 1)
    setRows(Math.max(1, Math.min(capacity, Math.max(1, dataLength))))
  }, [dataLength])

  // Recompute when the height changes; two delayed recomputes catch layout that settles after the effect
  useEffect(() => {
    measure()
    const timers = [250, 900].map((delay) => window.setTimeout(measure, delay))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [boxHeight, measure])

  return (
    <div
      ref={boxRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-fit-rows={rows}
      data-fit-small={tooSmall ? 1 : 0}
    >
      {tooSmall ? (
        <span className="truncate p-1 text-xs opacity-50">空间不足，放大窗口后显示表格</span>
      ) : (
        <Table<T>
          size="small"
          {...props.table}
          dataSource={
            pager ? props.table.dataSource : (props.table.dataSource ?? []).slice(0, rows)
          }
          pagination={
            pager
              ? { size: 'small', pageSize: rows, showSizeChanger: false, ...(props.table.pagination ?? {}) }
              : false
          }
        />
      )}
    </div>
  )
}

/**
 * Adaptive list: **greedily** pack rows - rows that do not fit are not drawn at all, and the rest
 * ends with a "N more" line.
 *
 * Why greedy instead of computing a row count: row gaps, dividers and the tail row all consume
 * height, and greedy packing guarantees the hard constraint "everything drawn adds up to <= the
 * container height". `rowHeight` must be **slightly larger** than the real row height; declaring it
 * too small accumulates into clipping.
 */
export function FitList<T>(props: {
  items: T[]
  rowHeight: number
  keyOf: (item: T, index: number) => React.Key
  renderItem: (item: T) => React.ReactNode
  empty?: React.ReactNode
  moreLabel?: (count: number) => string
  className?: string
}): React.JSX.Element {
  const [ref, size] = useSize()
  const gap = 6
  const moreHeight = 18
  const available = size.height
  const rendered: T[] = []
  let used = 0

  for (const item of props.items) {
    const need = (rendered.length > 0 ? gap : 0) + props.rowHeight
    if (used + need > available) break
    used += need
    rendered.push(item)
  }

  let more: string | null = null
  if (props.moreLabel && rendered.length < props.items.length) {
    const need = (rendered.length > 0 ? gap : 0) + moreHeight
    if (used + need <= available) {
      more = props.moreLabel(props.items.length - rendered.length)
    } else if (rendered.length > 0) {
      // Drop one row to fit the "N more" line in (it is more useful than showing one less row)
      rendered.pop()
      used -= props.rowHeight + gap
      more = props.moreLabel(props.items.length - rendered.length)
    }
  }

  return (
    <div ref={ref} className={'flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden ' + (props.className ?? '')}>
      {props.items.length === 0
        ? (props.empty ?? <span className="text-xs opacity-50">-</span>)
        : rendered.map((item, index) => (
            <div key={props.keyOf(item, index)} className="min-w-0 shrink-0">
              {props.renderItem(item)}
            </div>
          ))}
      {more ? <span className="shrink-0 text-xs opacity-50">{more}</span> : null}
    </div>
  )
}

/**
 * Chart container: measure the size first, then hand pixels to the SVG (do not let the SVG stretch,
 * or lines deform). Deliberately **no minimum height** - draw as tall as the container is and let the
 * chart degrade; a "minimum height" equals a fixed height and breaks out of the panel and the page.
 */
export function ChartBox(props: {
  children: (size: Size) => React.ReactNode
  className?: string
}): React.JSX.Element {
  const [ref, size] = useSize()
  return (
    <div ref={ref} className={'min-h-0 flex-1 ' + (props.className ?? '')}>
      {size.width > 0 && size.height > 0 ? props.children({ width: size.width, height: size.height }) : null}
    </div>
  )
}
