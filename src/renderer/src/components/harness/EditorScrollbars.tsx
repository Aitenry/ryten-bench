import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'

/**
 * Built-in editor scrollbars (floating overlay, VS Code look and feel).
 *
 * Why not native scrollbars: native scrollbars **eat 10px of the editor width**, so it looks
 * like a separate scrollbar gutter sits outside the editor instead of the file's own scrollbar
 * (two rounds of user feedback: "the scrollbar is not inside the editor").
 * Here the native scrollbars are hidden (`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`)
 * and a thin thumb is **drawn as an overlay** on the editor content area: text can run all the
 * way to the editor's right edge and the thumb overlays the content, consistent with VS Code.
 *
 * Behavior follows VS Code:
 * - Not shown at all when the content does not overflow;
 * - Faded out normally, fades in when the mouse is inside the editor or while scrolling (stays visible while dragging);
 * - The thumb is draggable (mapped proportionally to scrollTop/scrollLeft); clicking the track pages;
 * - Wheel/keyboard/trackpad scrolling is still handled by CodeMirror's native scroll container;
 *   this component only draws and drags.
 */

/** Minimum thumb length (px): stays grabbable even for very long content */
const MIN_THUMB = 28
/** The thumb is thinner than the track (2px inset on each side) for a lighter look */
const THUMB_INSET = 2
/** How long the thumb stays visible after scrolling */
const HOLD_MS = 900

interface ThumbRect {
  /** Start offset along the axis (px, relative to the track) */
  offset: number
  /** Length along the axis (px) */
  size: number
}

interface EditorScrollbarsProps {
  view: EditorView | null
  dark: boolean
}

const EditorScrollbars: React.FC<EditorScrollbarsProps> = ({ view, dark }) => {
  const [vThumb, setVThumb] = useState<ThumbRect | null>(null)
  const [hThumb, setHThumb] = useState<ThumbRect | null>(null)
  const [visible, setVisible] = useState(false)
  const [dragging, setDragging] = useState(false)
  const holdTimer = useRef<number | null>(null)
  /** Last computed thumb geometry: skips re-renders when nothing changed */
  const lastRects = useRef<{ v: ThumbRect | null; h: ThumbRect | null }>({ v: null, h: null })
  /** Geometry snapshot used while dragging (avoids recalculating every move and jittering) */
  const dragRef = useRef<{
    axis: 'v' | 'h'
    startPos: number
    startScroll: number
    ratio: number
  } | null>(null)

  /** Read geometry from the real scroll container and map it to the two thumbs */
  const sync = useCallback(() => {
    const el = view?.scrollDOM
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight, scrollLeft, scrollWidth, clientWidth } = el

    let nextV: ThumbRect | null = null
    if (scrollHeight > clientHeight + 1) {
      const size = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * clientHeight)
      const maxOffset = clientHeight - size
      const maxScroll = scrollHeight - clientHeight
      const offset = maxScroll > 0 ? (scrollTop / maxScroll) * maxOffset : 0
      nextV = { offset, size }
    }
    let nextH: ThumbRect | null = null
    if (scrollWidth > clientWidth + 1) {
      const size = Math.max(MIN_THUMB, (clientWidth / scrollWidth) * clientWidth)
      const maxOffset = clientWidth - size
      const maxScroll = scrollWidth - clientWidth
      const offset = maxScroll > 0 ? (scrollLeft / maxScroll) * maxOffset : 0
      nextH = { offset, size }
    }

    // Skip setState when values are unchanged: sync runs every frame while scrolling and blind re-rendering is pure waste
    const same = (a: ThumbRect | null, b: ThumbRect | null): boolean =>
      a === b ||
      (a !== null &&
        b !== null &&
        Math.round(a.offset) === Math.round(b.offset) &&
        Math.round(a.size) === Math.round(b.size))
    const prev = lastRects.current
    if (same(prev.v, nextV) && same(prev.h, nextH)) return
    lastRects.current = { v: nextV, h: nextH }
    setVThumb(nextV)
    setHThumb(nextH)
  }, [view])

  /** Briefly show the thumb while scrolling */
  const flash = useCallback(() => {
    setVisible(true)
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      if (!dragRef.current) setVisible(false)
    }, HOLD_MS)
  }, [])

  useEffect(() => {
    const el = view?.scrollDOM
    if (!el) return
    sync()
    const onScroll = (): void => {
      sync()
      flash()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Recompute on both content size changes (typing, folding, language switch) and container resizes
    const ro = new ResizeObserver(() => sync())
    ro.observe(el)
    if (view) ro.observe(view.contentDOM)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }, [view, sync, flash])

  const startDrag = useCallback(
    (axis: 'v' | 'h', thumb: ThumbRect) => (e: React.PointerEvent) => {
      const el = view?.scrollDOM
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      const startPos = axis === 'v' ? e.clientY : e.clientX
      const startScroll = axis === 'v' ? el.scrollTop : el.scrollLeft
      const track = axis === 'v' ? el.clientHeight : el.clientWidth
      const maxScroll =
        axis === 'v' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
      const maxOffset = track - thumb.size
      dragRef.current = {
        axis,
        startPos,
        startScroll,
        ratio: maxOffset > 0 ? maxScroll / maxOffset : 0
      }
      setDragging(true)

      const move = (ev: PointerEvent): void => {
        const drag = dragRef.current
        if (!drag) return
        const delta = (axis === 'v' ? ev.clientY : ev.clientX) - drag.startPos
        const next = drag.startScroll + delta * drag.ratio
        if (axis === 'v') el.scrollTop = next
        else el.scrollLeft = next
      }
      const up = (): void => {
        dragRef.current = null
        setDragging(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setVisible(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [view]
  )

  /** Click the track to page (the click position pages by one screen) */
  const onTrackPointerDown = useCallback(
    (axis: 'v' | 'h') => (e: React.PointerEvent) => {
      const el = view?.scrollDOM
      if (!el) return
      if (e.target !== e.currentTarget) return
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      if (axis === 'v') {
        const ratio = (e.clientY - rect.top) / rect.height
        el.scrollTop = ratio * el.scrollHeight - el.clientHeight / 2
      } else {
        const ratio = (e.clientX - rect.left) / rect.width
        el.scrollLeft = ratio * el.scrollWidth - el.clientWidth / 2
      }
      flash()
    },
    [view, flash]
  )

  if (!vThumb && !hThumb) return null

  const thumbBase: React.CSSProperties = {
    position: 'absolute',
    background: dark ? 'rgba(121,121,121,0.45)' : 'rgba(100,100,100,0.40)',
    borderRadius: 6,
    pointerEvents: 'auto',
    cursor: 'default',
    transition: dragging ? 'none' : 'opacity 0.2s',
    opacity: visible || dragging ? 1 : 0
  }

  return (
    <div
      data-testid="editor-scrollbars"
      data-dragging={dragging ? '1' : '0'}
      data-visible={visible ? '1' : '0'}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => {
        if (!dragging) setVisible(false)
      }}
    >
      {vThumb && (
        <div
          data-scrollbar="vertical"
          className="editor-scrollbar-track"
          data-thumb-offset={Math.round(vThumb.offset)}
          data-thumb-size={Math.round(vThumb.size)}
          onPointerDown={onTrackPointerDown('v')}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            right: 0,
            width: THUMB_INSET * 2 + 6,
            pointerEvents: 'auto',
            background: 'transparent'
          }}
        >
          <div
            className="editor-scrollbar-thumb"
            onPointerDown={startDrag('v', vThumb)}
            style={{
              ...thumbBase,
              top: vThumb.offset,
              height: vThumb.size,
              left: THUMB_INSET,
              right: THUMB_INSET,
              cursor: 'pointer'
            }}
          />
        </div>
      )}
      {hThumb && (
        <div
          data-scrollbar="horizontal"
          className="editor-scrollbar-track"
          data-thumb-offset={Math.round(hThumb.offset)}
          data-thumb-size={Math.round(hThumb.size)}
          onPointerDown={onTrackPointerDown('h')}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: THUMB_INSET * 2 + 6,
            pointerEvents: 'auto',
            background: 'transparent'
          }}
        >
          <div
            className="editor-scrollbar-thumb"
            onPointerDown={startDrag('h', hThumb)}
            style={{
              ...thumbBase,
              left: hThumb.offset,
              width: hThumb.size,
              top: THUMB_INSET,
              bottom: THUMB_INSET,
              cursor: 'pointer'
            }}
          />
        </div>
      )}
    </div>
  )
}

export default EditorScrollbars
