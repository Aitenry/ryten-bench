import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Table, theme as antdTheme, type ModalProps, type TableProps } from 'antd'
import { useTheme } from '@host/renderer/hooks/useTheme'

/**
 * 布局与配色原语：**插件界面的公共地基**，页面/组件都从这里取，别各写各的。
 *
 * 为什么模板自带这个文件：宿主页面容器的高度链是
 * `custom-frame-outer(100vh) → custom-frame(overflow:hidden,flex-col) → frame-body(flex-1,min-h-0)
 * → .frame-body-center(flex-1,overflow:auto,min-h-0，插件页面挂在这里)`，
 * 所以插件根节点用 `h-full` 拿到的就是一个**确定的高度**。
 * 下面这些原语的目标只有一个：**插件页面永不出滚动条**，内容多的时候按可用高度降级。
 */

export interface Size {
  width: number
  height: number
}

/** 监听元素自身尺寸（ResizeObserver）：图表与自适应容器靠它把「可用高度」变成像素 */
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

/** 配色表：中性色取 antd token，语义色按主题给两份 */
export interface PluginPalette {
  /** 当前是否是暗色主题 */
  dark: boolean
  /** 强调色（主按钮以外的强调、图表主线） */
  accent: string
  /** 正向 / 正常（成功、上升） */
  up: string
  /** 负向 / 危险（失败、下降） */
  down: string
  /** 警示（接近上限、待处理） */
  warn: string
  /** 边框（卡片、表格外框） */
  border: string
  /** 分隔线 / 图表网格线（比边框更淡） */
  split: string
  /** 软底（指标块这类淡色面板） */
  soft: string
  /** 轨道底色（进度条未填充部分） */
  track: string
  /** 坐标轴 / 次要说明文字 */
  axis: string
  /** 主文字（图表里需要显式给色的文本） */
  text: string
  /** 面板底色（用来「压住」图形元素，例如折线端点的小圆点） */
  surface: string
}

/**
 * 亮色语义色：都按「文字压在面板底色上对比度 >= 3:1」挑过一档深色，
 * 小字号数字才不虚（`#16a34a` 在白底只有 3.4，收深到 `#15803d` 是 4.9）。
 */
const LIGHT_SEMANTIC = {
  accent: '#8b5cf6',
  up: '#15803d',
  down: '#ef4444',
  warn: '#f59e0b'
}

/** 暗色语义色：在暗底上要「亮而不过曝」（antd 的 colorSuccess/colorError 做小字对比度不够） */
const DARK_SEMANTIC = {
  accent: '#a78bfa',
  up: '#4ade80',
  down: '#f87171',
  warn: '#fbbf24'
}

/**
 * 界面配色表：**组件里不出现字面量色值**，一律从这里取。
 *
 * 为什么不能靠 Tailwind 的 `dark:` 变体（真实事故：用户反馈「没有适配黑暗主题」）：
 * 工坊编 `plugin.css` 用的是 `tailwindcss/theme + utilities`，没有 `@custom-variant dark`，
 * 所以 `dark:bg-x` 落成的是 **`@media (prefers-color-scheme: dark)`**（跟操作系统配色）；
 * 而宿主是靠 `document.documentElement` 上的 `.dark` 类 + antd `darkAlgorithm` 切主题的
 * （主题模式还支持按时间自动切，与系统配色无关）。两者对不上：
 * 应用暗色 + 系统亮色 = 插件仍画浅色；应用亮色 + 系统暗色 = 插件反而画暗色。
 *
 * 所以：
 * - **中性色取 antd token**（`theme.useToken()`）——由 `darkAlgorithm` 算好，跟着主题走；
 * - **语义色给亮/暗两份**，暗色判定用宿主 `useTheme()` 的 `effectiveTheme`
 *   （与 antd 算法、`.dark` 类**同源**，不会三者不一致）；
 * - 需要底色变化时用**中性半透明**（见 `HOVER_BG`），叠在主题底色上亮暗都成立。
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
    // 暗色下 token 的软底偏亮，用更轻的手调值贴暗底观感
    soft: dark ? 'rgba(255, 255, 255, 0.04)' : token.colorFillQuaternary,
    track: token.colorFillSecondary,
    axis: token.colorTextTertiary,
    text: token.colorText,
    surface: token.colorBgContainer
  }
}

/**
 * 悬停 / 选中的底色：**中性半透明**，叠在任意主题底色上都成立
 * （宿主自己的侧栏也这么写）。写成固定的浅灰在暗色下就是一块亮斑。
 */
export const HOVER_BG = 'rgba(128, 128, 128, 0.12)'

/** 可悬停的一行：底色用中性半透明（列表行、菜单项的通用壳子） */
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
 * 表单弹窗的高度上限：**标题与按钮固定，正文自己滚**。
 *
 * 为什么必须限制（真实事故：用户反馈「弹出高度不能没有限制，会导致整体出现滚动条」）：
 * 弹窗高度若由内容决定就没有上限——10 个字段的表单约 620px 正文，加头脚与 antd 默认的
 * `top: 100px` 整块 737px。窗口矮一点（1200×660）就装不下，而这时候能滚的是
 * `.ant-modal-wrap`（`position: fixed; overflow: auto`，**铺满整个视口**）：
 * 窗口右边缘冒出一条「整页」滚动条，滚的是整个对话框——标题和「保存」一起被滚出视口，
 * 按钮常常落在屏幕外点不到。
 *
 * 做法：给弹窗的白面板一个 `max-height` 并让它成为列方向的 flex 容器，头脚 `shrink-0`、
 * 正文 `flex:1 / min-height:0 / overflow:auto`，挤出来的空间全给正文。
 * **不要**给正文写死 `max-height: calc(100vh - Npx)`：头脚高度会随标题行数、字号、
 * 语言变，写死的 N 一旦算少，wrap 的滚动条就又回来了；flex 链跟着容器走，不需要预算。
 *
 * 语义名注意：antd 6 里白面板叫 **`container`**（`.ant-modal-container`，v5 时代叫
 * `content`/`.ant-modal-content`）。写 `styles.content` 会被 TS 直接拒绝（TS2353）。
 *
 * 用法：`<Modal {...formModalProps} open={...}>`；纯展示、字段很少的弹窗用 `createModalProps`
 * （只收 top，不需要内部滚动）。**每个 Modal 至少展开其中一个。**
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

/** 内容恒定的短弹窗（确认框、说明框）：只把 top 收下来，其它交给 antd */
export const createModalProps: Pick<ModalProps, 'style'> = { style: { top: 24 } }

/**
 * antd 6 Tabs 撑满高度的正确写法（**两个坑都在这里**）：
 *
 * 1. 每个页签**各自是一个 `.ant-tabs-content`**（老的 `.ant-tabs-content-holder` 结构已经没有了），
 *    而且 antd 会把**访问过的**页签都留在 DOM 里。所以给 `styles.content` 写 `flex:1` 会让
 *    这些 pane 瓜分高度——访问 6 个页签时当前页只剩 1/6 高，内容被裁。`position:absolute; inset:0`
 *    才是对的（每个 pane 铺满 body，只有激活的那个可见）；
 * 2. `styles.content` 里**绝对不能写 `display`**：antd 靠 `.ant-tabs-content-hidden`
 *    这个**类选择器**隐藏非激活页签，内联样式优先级更高，一旦写了 `display:flex` 隐藏即失效，
 *    访问过的页签会全部 absolute 叠在一起同时画出来（症状：「内容都挤在一堆」）。
 *    页签内部的列布局交给 Pane（`h-full` + 自己的 flex）。
 *
 * 用法：`<Tabs {...pageTabsProps} items={...} />`，外层给它 `min-h-0 flex-1`。
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
 * 页面外壳：撑满宿主给的高度、**自己不滚**。
 *
 * 根节点**绝不能带 `overflow-auto`**（这是最容易犯的错）：它会把标题、页签一起滚出窗口，
 * 也就是用户看到的「整页滚动条」。页面内部要滚动的话，只给某一个内容块加
 * `min-h-0 flex-1 overflow-y-auto`。
 *
 * `scroll` 是逃生舱：真的需要一根页面内滚动条时显式打开（此时头部仍然固定）。
 */
export function PageShell(props: {
  header?: React.ReactNode
  children: React.ReactNode
  /** 内容区是否自己滚（默认 false：整页锁死在窗口内，内容按高度自适应） */
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

/** 页面头：标题 + 右侧操作，永远一行放下、不随内容滚动 */
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

/** 页签内容区：铺满 pane（pane 是 absolute + inset:0，所以 h-full 就够） */
export function Pane(props: { children: React.ReactNode }): React.JSX.Element {
  return <div className="h-full w-full min-h-0 overflow-hidden">{props.children}</div>
}

/**
 * 面板：填满剩余高度、自身不出滚动条的卡片（标题栏固定，正文自己分配剩余空间）。
 *
 * 用 Card 的 `styles.root/header/body` 把内部结构打通成 flex 列——
 * 默认的 Card 是「高度由内容决定」，放进一行 grid 里就会把网格顶破。
 */
export function Panel(props: {
  title?: React.ReactNode
  extra?: React.ReactNode
  children: React.ReactNode
  /** 正文是否自己滚（默认 false：正文里放自适应原语） */
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

/** 空态：一行居中灰字（与宿主空态同款；不写说明段落、不加按钮） */
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
 * 自适应表格：按**容器可用高度**算容量，永远不出纵向滚动条。
 * 语义与 antd Table 一致（`table` 直接透传）。
 *
 * 两条硬规则（都是踩出来的）：
 * 1. **不要用「量余量 → 加/减一行」的收敛环**：布局常晚于 effect 到位（字体、表格自身的
 *    一次性布局），effect 量到的余量是 0 于是什么都不做，650ms 后其实已经溢出 18~54px。
 *    这里改成「量部件高度（表头 / 行 / 分页器）→ 一次算容量」：容量是
 *    `f(容器高, 表头, 行高, 分页器占高)` 的纯函数，与当前画了几行无关，所以不需要收敛也不会抖；
 * 2. **`pagination={false}` 的语义是「不分页」= 把所有行都画出来**（实测 3 行 156px 塞进
 *    115px 的盒子，被裁 41px）。要「少画几行」必须自己 `dataSource.slice(0, rows)`（下面就是）。
 *
 * 单元格内容一律 `min-w-0` + 省略号兜底：只要有列写了 `ellipsis: true`，表格就变成
 * `table-layout: fixed`，没写 `width` 的列只分「剩余宽度」，而 `td` 的 overflow 是 visible
 * ——比列宽宽的内容会**叠到隔壁列上**（不是被裁）。
 */
export function FitTable<T extends object>(props: {
  table: TableProps<T>
  /** 只用于初始估算；真实行高在运行时量出来 */
  rowHeight?: number
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [boxHeight, setBoxHeight] = useState(0)
  const [rows, setRows] = useState(1)
  const [pager, setPager] = useState(true)
  const [tooSmall, setTooSmall] = useState(false)
  // 部件实测高度（表头 / 行 / 分页器含外边距）；表格没画出来时沿用上次测到的值，
  // 否则「退化」判断会因为「现在没画表格」把高度当 0，来回翻。
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
    // 连「表头 + 一行」都放不下：不画表格（画了必被裁），交给调用方给的兜底提示
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

  // 高度变了就重算；再补两次延时重算，接住「晚于 effect 才到位」的布局
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
 * 自适应列表：**贪心**塞行——放不下的行一个都不画，剩下的用「还有 N 项」收尾。
 *
 * 为什么贪心而不是算行数：行距、分隔、尾行都会吃掉高度，贪心能保证
 * 「画出来的东西加起来 <= 容器高度」这个硬约束。`rowHeight` 要**略大于**真实行高，
 * 声明小了会一点点累积成裁切。
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
      // 回退一行，把「还有 N 项」放进来（它比少显示一行更有用）
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
 * 图表容器：量好尺寸再把像素交给 SVG（不给 SVG 伸展，避免线条变形）。
 * 刻意**不设最小高度**——容器多矮就画多矮，图表自己降级；
 * 「最小高度」等于固定高度，会把面板和整页顶破。
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
