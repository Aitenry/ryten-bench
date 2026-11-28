import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view'
import { getChunks, type Chunk } from '@codemirror/merge'
import type { Extension } from '@codemirror/state'

/**
 * Per-hunk accept/reject buttons for the diff view — drawn in the **change gutter** rather than
 * inside the deleted chunk.
 *
 * Background: @codemirror/merge's built-in `mergeControls` squeezes two **text buttons**
 * ("accept / revert") into `.cm-deletedChunk` with `position: absolute; insetInlineEnd: 5px` —
 * that is, on the right end of the body line. When a deleted chunk has several lines the buttons
 * scroll out of sight with it, and being text they do not match the icon-only buttons elsewhere in
 * this editor (toolbar, status bar).
 *
 * Now `mergeControls: false` turns off the built-in buttons and this extension lays an absolutely
 * positioned layer of icon buttons over `.cm-gutters` (the line-number gutter, including the 3px
 * change gutter `.cm-changeGutter`), **one per hunk**, vertically aligned with that hunk's first
 * line (a deleted chunk has its own height — use its real rect, do not guess with lineBlockAt).
 * The icons come from the same source as the toolbar (remixicon check / close with inline paths,
 * the same approach as cmFoldGutter).
 *
 * Details that must hold:
 * - Buttons listen on `mousedown`, not `click`: this matches CodeMirror's own implementation and
 *   fires before the cursor/selection update; otherwise the click moves the cursor first and the
 *   hunk is then looked up at the new position, so you may act on a different hunk than the one
 *   clicked;
 * - **Recompute top on every geometry change**: collapsing unchanged regions
 *   (collapseUnchanged), wrapping, font loading, and panel width changes all alter line heights,
 *   so cached coordinates drift;
 * - Recomputes must be batched through `requestAnimationFrame`: `update()` runs several times per
 *   input, and reading geometry synchronously each time forces a reflow (visibly janky on long
 *   documents).
 */

/** Button diameter (px): big enough to hit, small enough not to cover an adjacent button */
const BUTTON_SIZE = 18
/** Minimum separation between two button groups when two hunks are very close */
const MIN_GAP = 2

/** remixicon check-line / close-line (viewBox 24, same-named components in @remixicon/react) */
const ICON_CHECK_D =
  'M9.9997 15.1709L19.1921 5.97852L20.6063 7.39273L9.9997 17.9993L3.63574 11.6354L5.04996 10.2212L9.9997 15.1709Z'
const ICON_CLOSE_D =
  'M11.9997 10.5865L16.9495 5.63672L18.3637 7.05093L13.4139 12.0007L18.3637 16.9504L16.9495 18.3646L11.9997 13.4149L7.04996 18.3646L5.63574 16.9504L10.5855 12.0007L5.63574 7.05093L7.04996 5.63672L11.9997 10.5865Z'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface ChunkActionOptions {
  /** Accept this hunk (adopt the model's version) */
  acceptLabel: string
  /** Reject this hunk (restore the pre-change version) */
  rejectLabel: string
  /** On accept: receives this hunk's start position in the **current document** */
  onAccept: (pos: number) => void
  /** On reject: same as above */
  onReject: (pos: number) => void
}

/** Build a remixicon-style inline SVG (same approach as the fold gutter) */
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

/** Vertical extent of one hunk (relative to the editor's top-left corner) */
interface ItemBox {
  top: number
  height: number
  pos: number
}

/**
 * Get the **deleted chunk element** for a hunk (content unique to document A renders on the
 * `.cm-deletedChunk` block-level widget).
 *
 * How to find it: the widget's left edge is chunk.fromB (block-level widgets have side -1), so
 * look it up in reverse from fromB with `posAtDOM`; the start position falls inside the widget's
 * root element. Returns null on a miss (the hunk has no deleted content, or the view is not laid
 * out yet), and the caller falls back to the approximate geometry from `lineBlockAt`.
 */
function deletedChunkDomAt(view: EditorView, pos: number): HTMLElement | null {
  const start = view.domAtPos(pos)
  const node = start.node
  const element =
    node.nodeType === 1 ? (node as HTMLElement) : ((node.parentElement as HTMLElement) ?? null)
  return element?.closest('.cm-deletedChunk') ?? null
}

/**
 * Measure the vertical position of every hunk.
 *
 * Positions in document B use `lineBlockAt` directly; content unique to document A (deletions)
 * renders on the `.cm-deletedChunk` block-level widget, whose height lineBlockAt cannot measure —
 * only the widget's own rect works. This is exactly what makes the buttons align with the first
 * line of the deleted chunk.
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
 * Compress the measured vertical extents into non-overlapping button positions.
 *
 * When hunks are dense (a dozen changed lines in a row, or two hunks adjacent after folding) the
 * buttons pile up and which one you hit is luck. Only **minimal pushing** is applied: working from
 * bottom to top, keep at least one button height between neighbours, and preserve hunk order
 * (otherwise the visual "previous / next hunk" order would lie).
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

/** Create a button with an icon */
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
    // Matches CodeMirror's own implementation: act on mousedown so the click does not move the
    // cursor first. Also prevent the default so the editor does not lose focus/selection from it.
    event.preventDefault()
    event.stopPropagation()
    args.onAction(args.pos)
    args.schedule()
  })
  // Browsers may not dispatch mousedown for touch/pen input (or dispatch it late); keep this
  // interaction from reaching the editor
  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
  })
  return button
}

/**
 * Build the "accept/reject buttons in the change gutter" extension.
 *
 * The labels and callbacks passed in stay stable for the extension's lifetime (the caller pins them
 * with useMemo + ref), so no dynamic reconfiguration happens here: switching language rebuilds the
 * whole diff view (it depends on t).
 */
export function chunkActionGutter(options: ChunkActionOptions): Extension {
  const build = (view: EditorView): PluginValue => {
    const layer = document.createElement('div')
    layer.className = 'cm-chunkActionLayer'
    // The empty layer does not intercept events: only the buttons themselves consume mousedown
    layer.style.pointerEvents = 'none'

    /**
     * Mounted on `.cm-editor`, with the editor's top-left corner as origin.
     *
     * Note: CodeMirror 6's ViewPlugin does **not** automatically insert a value's `dom` into the
     * editor (older docs claimed so; 6.43's PluginInstance does not read `value.dom`). So
     * `appendChild` here and remove it in destroy, otherwise plugin rebuilds leave ghost layers.
     */
    view.dom.appendChild(layer)

    let frame: number | null = null

    /**
     * Recompute and repaint.
     *
     * `view.dom` (.cm-editor) is the positioning parent with the editor's top-left corner as
     * origin: `.cm-gutters` hugs the editor's left edge, so the two coordinate systems align
     * naturally. `.cm-gutters` itself is `position: sticky`, so mounting the layer inside it would
     * pin the layer along with the gutters.
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
        // Buttons sit to the right of the change gutter; the whole group is right-aligned to the
        // editor's left edge line
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

    /** Batched recompute: update can fire several times per input, so do not read geometry
     * synchronously each time */
    const schedule = (): void => {
      if (frame !== null) return
      frame = requestAnimationFrame(paint)
    }

    return {
      update(update: ViewUpdate): void {
        // Document changed (accept/reject/edit) → hunk set changed; viewport or height changed →
        // coordinates changed
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

/** For test assertions: the number of hunks in the current editor */
export function chunkCount(view: EditorView): number {
  return getChunks(view.state)?.chunks.length ?? 0
}

/**
 * For offline tooling only: exposes the "measure geometry → lay out positions" steps separately.
 *
 * Both steps are pure logic (CodeMirror geometry readings in, button coordinates out), so exposing
 * them lets regression scripts verify directly in jsdom **without a real layout engine**: whether
 * buttons fall inside the change-gutter range, align with each hunk's first line, and dense hunks
 * get pushed apart.
 */
export const __chunkActionGeometry = { measureItems, layoutItems, BUTTON_SIZE, MIN_GAP }

export type { Chunk }
