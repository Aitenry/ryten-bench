import { GutterMarker } from '@codemirror/view'
import { foldGutter, foldKeymap } from '@codemirror/language'

/**
 * Fold gutter marker: uses the app's unified remixicon icons instead of CodeMirror's built-in
 * `⌄ / ›` characters.
 *
 * CodeMirror's default marker is plain text (`<span title="Fold line">⌄</span>`), which is not
 * the same set as the other icons in the UI (remixicon components): weight, centering and look
 * all differ. `foldGutter({ markerDOM })` allows building the DOM ourselves, so the remixicon
 * paths are inlined into an `<svg>` right here.
 *
 * ⚠️ Both states must use icons from the **same family**, otherwise size and weight won't match
 * (measured glyph bounding boxes, viewBox 24):
 * - `arrow-drop-down-line` 8.49 × 5.66 (drop family: chunky little arrow)
 * - `arrow-drop-right-line` 5.66 × 8.49 (drop family: same shape rotated 90°)
 * - `arrow-down-s-line`    12.73 × 7.78 (s-line family: thin stroked arrow)
 * - `arrow-right-s-line`    7.78 × 12.73 (s-line family)
 * Mixing them (e.g. drop for expanded, s-line for collapsed) makes the collapse arrow look more
 * than twice as large as the expand arrow.
 *
 * Paths are taken from the same-named components in `@remixicon/react` (extracted by rendering
 * with react-dom/server).
 */
const ARROW_DROP_DOWN_D =
  'M12 15.0006L7.75732 10.758L9.17154 9.34375L12 12.1722L14.8284 9.34375L16.2426 10.758L12 15.0006Z'
const ARROW_DROP_RIGHT_D =
  'M12.1717 12.0005L9.34326 9.17203L10.7575 7.75781L15.0001 12.0005L10.7575 16.2431L9.34326 14.8289L12.1717 12.0005Z'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Build a remixicon-style inline SVG.
 *
 * Drop-family glyphs occupy only about 1/4 of the 24 viewBox (8.5×5.7 px), so they render small
 * at 16px and don't match the line numbers visually; scale up slightly to 20px (glyph about
 * 7×4.7px, matching 12.5px line numbers).
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

/** Fold gutter marker: expanded foldable lines show a down arrow, collapsed lines show a right arrow (same semantics as the file explorer) */
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
 * Fold extension: icon-ified fold gutter + the same keyboard bindings as the editor.
 * `openText/closedText` only apply when markerDOM is absent; a markerDOM is provided here, but
 * they are kept as accessibility labels (screen readers read the title).
 */
export const rytenFoldGutter = foldGutter({
  markerDOM: (open: boolean) => new FoldMarker(open).toDOM() as HTMLElement,
  openText: '折叠',
  closedText: '展开'
})

export { foldKeymap, FoldMarker }
