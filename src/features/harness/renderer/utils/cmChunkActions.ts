import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view'
import { getChunks, type Chunk } from '@codemirror/merge'
import type { Extension } from '@codemirror/state'

/**
 * 差异视图的「逐处取舍」按钮 —— 画在**改动槽**里，而不是删除块内部。
 *
 * 背景（用户 2026-09-23）：@codemirror/merge 自带的 `mergeControls` 把两个**文字按钮**
 * （「保留 / 撤销」）用 `position: absolute; insetInlineEnd: 5px` 塞进 `.cm-deletedChunk`
 * 内部——也就是压在正文行的右端。删除块有多行时，按钮跟着块一起滚到看不见的地方，
 * 而且它们是文字，跟这个编辑器里其余「只有图标」的按钮（工具条、状态条）不是一套语言。
 *
 * 现在改成：`mergeControls: false` 关掉自带按钮，由本扩展在 `.cm-gutters`（行号槽，
 * 含 3px 改动槽 `.cm-changeGutter`）之上铺一层绝对定位的图标按钮，**一处差异一个**，
 * 纵向与该处差异的首行对齐（删除块有自己的高度，用它的真实矩形，别用 lineBlockAt 猜）。
 * 图标与工具条同源（remixicon 的 check / close，路径内联，见 cmFoldGutter 的同一做法）。
 *
 * 几个必须守住的细节：
 * - 按钮用 `mousedown` 而不是 `click`：与 CodeMirror 自带实现一致，先于光标/选区更新触发，
 *   否则点击会先把光标挪到别处、再按新光标找 chunk，取舍的可能不是你点的那一处；
 * - 每次几何变化都要**重算 top**：折叠未改动区（collapseUnchanged）、换行、字体加载、
 *   面板宽度变化都会让行高变，缓存的坐标会飘；
 * - 重算必须走 `requestAnimationFrame` 合帧：`update()` 在一次输入里会被调用多次，
 *   每次都同步读几何会触发强制重排（长文档上肉眼可见地卡）。
 */

/** 按钮直径（px）：够点得中，又不至于盖住相邻改动的按钮 */
const BUTTON_SIZE = 18
/** 两处差异靠得很近时，两个按钮组至少拉开的距离 */
const MIN_GAP = 2

/** remixicon 的 check-line / close-line（viewBox 24，取自 @remixicon/react 的同名组件） */
const ICON_CHECK_D =
  'M9.9997 15.1709L19.1921 5.97852L20.6063 7.39273L9.9997 17.9993L3.63574 11.6354L5.04996 10.2212L9.9997 15.1709Z'
const ICON_CLOSE_D =
  'M11.9997 10.5865L16.9495 5.63672L18.3637 7.05093L13.4139 12.0007L18.3637 16.9504L16.9495 18.3646L11.9997 13.4149L7.04996 18.3646L5.63574 16.9504L10.5855 12.0007L5.63574 7.05093L7.04996 5.63672L11.9997 10.5865Z'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface ChunkActionOptions {
  /** 保留这一处（采用模型的写法） */
  acceptLabel: string
  /** 撤销这一处（还原改动前的写法） */
  rejectLabel: string
  /** 点「保留」：接收该处差异在**当前文档**里的起始位置 */
  onAccept: (pos: number) => void
  /** 点「撤销」：同上 */
  onReject: (pos: number) => void
}

/** 造一个 remixicon 风格的内联 SVG（与折叠槽同一套做法） */
function remixicon(pathD: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', pathD)
  svg.appendChild(path)
  return svg
}

/** 一处差异的纵向占位（相对编辑器左上角） */
interface ItemBox {
  top: number
  height: number
  pos: number
}

/**
 * 取某处差异的**删除块元素**（文档 A 独有的内容渲染在 `.cm-deletedChunk` 这个块级 widget 上）。
 *
 * 摸法：widget 的左缘就是 chunk.fromB（块级 widget 的 side 为 -1），所以拿 fromB 去
 * `posAtDOM` 反查，起点正好落进 widget 的根元素里；命中不到（该处差异没有删除内容、
 * 或视图还没布局）就返回 null，调用方退回 `lineBlockAt` 的近似几何。
 */
function deletedChunkDomAt(view: EditorView, pos: number): HTMLElement | null {
  const start = view.domAtPos(pos)
  const node = start.node
  const element =
    node.nodeType === 1 ? (node as HTMLElement) : ((node.parentElement as HTMLElement) ?? null)
  return element?.closest('.cm-deletedChunk') ?? null
}

/**
 * 量出每一处差异的纵向位置。
 *
 * 文档 B 里的位置直接用 `lineBlockAt`；文档 A 独有的内容（删除）渲染在
 * `.cm-deletedChunk` 这个块级 widget 上，它的高度 lineBlockAt 是量不到的，
 * 只能读 widget 自己的矩形——这也正是「按钮要对齐到删除块起始行」的关键。
 */
function measureItems(view: EditorView): ItemBox[] {
  const result = getChunks(view.state)
  if (!result || result.chunks.length === 0) return []
  const editorTop = view.dom.getBoundingClientRect().top
  const items: ItemBox[] = []
  for (const chunk of result.chunks) {
    const pos = chunk.fromB
    let box: { top: number; height: number } | null = null
    const chunkDom = deletedChunkDomAt(view, pos)
    if (chunkDom) {
      const rect = chunkDom.getBoundingClientRect()
      box = { top: rect.top - editorTop, height: rect.height }
    }
    if (!box) {
      const block = view.lineBlockAt(Math.min(pos, view.state.doc.length))
      box = { top: block.top, height: block.height }
    }
    items.push({ ...box, pos })
  }
  return items
}

/**
 * 把量到的纵向占位压成不重叠的按钮位置。
 *
 * 差异密集时（连续改十几行、或折叠后两处差异贴在一起）按钮会叠成一团，
 * 点哪个全靠运气。这里只做**最小推挤**：从下往上保证彼此至少隔一个按钮高，
 * 顺序与差异顺序始终一致（否则「上一处 / 下一处」的视觉顺序会骗人）。
 */
function layoutItems(items: ItemBox[]): { top: number; pos: number }[] {
  const sorted = [...items].sort((a, b) => a.top - b.top)
  const placed: { top: number; pos: number }[] = []
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const item = sorted[i]
    const next = placed[0]
    const limit =
      next && next.top - item.top < BUTTON_SIZE + MIN_GAP
        ? next.top - BUTTON_SIZE - MIN_GAP
        : item.top
    placed.unshift({ top: Math.max(0, Math.min(item.top, limit)), pos: item.pos })
  }
  return placed
}

/** 造一个带图标的按钮 */
function makeButton(args: {
  name: 'accept' | 'reject'
  label: string
  icon: string
  pos: number
  onAction: (pos: number) => void
  schedule: () => void
}): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.name = args.name
  button.className = `cm-chunkAction cm-chunkAction-${args.name}`
  button.dataset.chunkAction = args.name
  button.title = args.label
  button.setAttribute('aria-label', args.label)
  button.tabIndex = -1
  button.appendChild(remixicon(args.icon))
  button.addEventListener('mousedown', (event) => {
    // 与 CodeMirror 自带实现一致：mousedown 里就取舍，避免点击先把光标挪走。
    // 同时阻止默认行为，别让编辑器因这次点击丢掉焦点/选区。
    event.preventDefault()
    event.stopPropagation()
    args.onAction(args.pos)
    args.schedule()
  })
  // 触摸/笔触发时浏览器可能不派发 mousedown（或延迟派发），别让这次交互落到编辑器上
  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
  })
  return button
}

/**
 * 构建「改动槽里的取舍按钮」扩展。
 *
 * 传进来的文案与回调在扩展生命周期内保持稳定（调用方用 useMemo + ref 固定），
 * 因此这里不做动态重配置：语言切换时整个差异视图会重建（依赖 t）。
 */
export function chunkActionGutter(options: ChunkActionOptions): Extension {
  const build = (view: EditorView): PluginValue => {
    const layer = document.createElement('div')
    layer.className = 'cm-chunkActionLayer'
    // 空层不拦事件：整层只有按钮自己吃 mousedown
    layer.style.pointerEvents = 'none'

    /**
     * 挂在 `.cm-editor` 上，以编辑器左上角为原点。
     *
     * 注意：CodeMirror 6 的 ViewPlugin **不会**自动把 value 上的 `dom` 插进编辑器
     * （只有旧文档说法如此；6.43 的 PluginInstance 不读 `value.dom`）。所以这里自己
     * `appendChild`，并在 destroy 里摘掉，否则插件重建会留下一堆幽灵层。
     */
    view.dom.appendChild(layer)

    let frame: number | null = null

    /**
     * 重算并重画。
     *
     * 用 `view.dom`（.cm-editor）作为定位父元素、以编辑器左上角为原点：
     * `.cm-gutters` 就贴在编辑器左边缘，两者坐标系天然对齐；而 `.cm-gutters` 自己是
     * `position: sticky`，把层挂进去反而会被一起钉住。
     */
    const paint = (): void => {
      frame = null
      const items = layoutItems(measureItems(view))
      if (items.length === 0) {
        layer.replaceChildren()
        return
      }
      const fragment = document.createDocumentFragment()
      for (const item of items) {
        const group = document.createElement('div')
        group.className = 'cm-chunkActionGroup'
        group.dataset.chunkPos = String(item.pos)
        // 按钮落在改动槽右侧，整组右对齐到编辑器左边缘那条线
        group.style.top = `${Math.round(item.top)}px`
        group.appendChild(
          makeButton({
            name: 'accept',
            label: options.acceptLabel,
            icon: ICON_CHECK_D,
            pos: item.pos,
            onAction: options.onAccept,
            schedule
          })
        )
        group.appendChild(
          makeButton({
            name: 'reject',
            label: options.rejectLabel,
            icon: ICON_CLOSE_D,
            pos: item.pos,
            onAction: options.onReject,
            schedule
          })
        )
        fragment.appendChild(group)
      }
      layer.replaceChildren(fragment)
    }

    /** 合帧重算：一次输入里 update 可能来好几次，别每次都同步读几何 */
    const schedule = (): void => {
      if (frame !== null) return
      frame = requestAnimationFrame(paint)
    }

    return {
      update(update: ViewUpdate): void {
        // 文档变了（取舍/编辑）→ 差异集合变了；视口或高度变了 → 坐标变了
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.heightChanged ||
          update.geometryChanged
        ) {
          schedule()
        }
      },
      destroy(): void {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        layer.remove()
      }
    }
  }

  return ViewPlugin.define(build)
}

/** 供测试断言用：当前编辑器的差异处数 */
export function chunkCount(view: EditorView): number {
  return getChunks(view.state)?.chunks.length ?? 0
}

/**
 * 仅供离线工装使用：把「量几何 → 排位置」两步单独暴露出来。
 *
 * 这两步是纯逻辑（输入 CodeMirror 的几何读数，输出按钮坐标），把它暴露出来，
 * 回归脚本就能在**没有真实布局引擎**的 jsdom 里直接验算：
 * 按钮是否落在改动槽区间、是否与各自差异的首行对齐、密集差异是否被拉开。
 */
export const __chunkActionGeometry = { measureItems, layoutItems, BUTTON_SIZE, MIN_GAP }

export type { Chunk }
