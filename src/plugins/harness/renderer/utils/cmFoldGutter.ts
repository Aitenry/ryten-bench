import { GutterMarker } from '@codemirror/view'
import { foldGutter, foldKeymap } from '@codemirror/language'

/**
 * 折叠槽标记：用应用统一的 remixicon 图标，而不是 CodeMirror 自带的 `⌄ / ›` 字符。
 *
 * CodeMirror 默认标记是纯文本（`<span title="Fold line">⌄</span>`），和界面里其余图标
 * （remixicon 组件）不是一套，粗细/居中/观感都不一致。`foldGutter({ markerDOM })` 允许
 * 自己造 DOM，这里就地把 remixicon 图标的路径内联成 `<svg>`。
 *
 * ⚠️ 两个状态必须取**同一家族**的图标，否则大小/粗细对不上（实测图形包围盒，viewBox 24）：
 * - `arrow-drop-down-line` 8.49 × 5.66（drop 家族：厚实的小箭头）
 * - `arrow-drop-right-line` 5.66 × 8.49（drop 家族：同一形状旋转 90°）
 * - `arrow-down-s-line`    12.73 × 7.78（s-line 家族：细长的描边箭头）
 * - `arrow-right-s-line`    7.78 × 12.73（s-line 家族）
 * 混用（比如展开用 drop、折叠用 s-line）会让折叠箭头看着比展开箭头大一倍多。
 *
 * 路径取自 `@remixicon/react` 的同名组件（用 react-dom/server 渲染提取，见文档 0cca4445）。
 */
const ARROW_DROP_DOWN_D =
  'M12 15.0006L7.75732 10.758L9.17154 9.34375L12 12.1722L14.8284 9.34375L16.2426 10.758L12 15.0006Z'
const ARROW_DROP_RIGHT_D =
  'M12.1717 12.0005L9.34326 9.17203L10.7575 7.75781L15.0001 12.0005L10.7575 16.2431L9.34326 14.8289L12.1717 12.0005Z'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 造一个 remixicon 风格的内联 SVG。
 *
 * drop 家族的图形只占画布 24 的约 1/4（8.5×5.7 px），按 16px 渲染出来偏小、
 * 和行号不在一个视觉量级上，所以稍微放大量到 20px（图形约 7×4.7px，与 12.5px 行号相称）。
 */
const MARKER_SIZE = 20

function remixicon(pathD: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(MARKER_SIZE))
  svg.setAttribute('height', String(MARKER_SIZE))
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', pathD)
  svg.appendChild(path)
  return svg
}

/** 折叠槽标记：展开可折叠的行显示向下箭头，已折叠的行显示向右箭头（与资源管理器同一套语义） */
class FoldMarker extends GutterMarker {
  readonly open: boolean

  constructor(open: boolean) {
    super()
    this.open = open
  }

  eq(other: GutterMarker): boolean {
    return other instanceof FoldMarker && other.open === this.open
  }

  toDOM(): Node {
    return remixicon(this.open ? ARROW_DROP_DOWN_D : ARROW_DROP_RIGHT_D)
  }
}

/**
 * 折叠扩展：图标化的折叠槽 + 与编辑器一致的键盘绑定。
 * `openText/closedText` 只在 markerDOM 缺省时生效；这里给了 markerDOM，
 * 但仍保留它们作无障碍标签（读屏会念 title）。
 */
export const rytenFoldGutter = foldGutter({
  markerDOM: (open: boolean) => new FoldMarker(open).toDOM() as HTMLElement,
  openText: '折叠',
  closedText: '展开'
})

export { foldKeymap, FoldMarker }
