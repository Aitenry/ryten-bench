import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'

/**
 * 编辑器内置滚动条（悬浮覆盖式，VS Code 观感）。
 *
 * 为什么不用原生滚动条：原生滚动条会**占掉编辑器 10px 宽度**，看起来是「编辑器外面另有一条
 * 滚动条槽」，而不是文件自己的滚动条（用户两轮反馈「滚动条并没有在编辑器内部」）。
 * 这里把原生滚动条隐藏（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`），
 * 在编辑器内容区上**悬浮绘制**一条细滑块：文字可以一直排到编辑器右边缘、滑块压在内容之上，
 * 与 VS Code 一致。
 *
 * 行为对齐 VS Code：
 * - 内容不溢出时完全不出现；
 * - 平时淡出，鼠标在编辑器内或滚动时淡入（拖动中常显）；
 * - 滑块可拖（按比例映射到 scrollTop/scrollLeft），点击轨道翻页；
 * - 滚轮/键盘/触控板滚动仍然由 CodeMirror 的原生滚动容器处理，这里只负责「画」和「拖」。
 */

/** 滑块最小长度（px）：内容很长时也要抓得住 */
const MIN_THUMB = 28
/** 滑块比轨道细（两侧各留 2px），观感更轻 */
const THUMB_INSET = 2
/** 滚动后滑块保持可见的时间 */
const HOLD_MS = 900

interface ThumbRect {
  /** 沿轴方向的起点（px，相对轨道） */
  offset: number
  /** 沿轴方向的长度（px） */
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
  /** 上一次算出来的滑块几何：用于跳过无变化的重渲染 */
  const lastRects = useRef<{ v: ThumbRect | null; h: ThumbRect | null }>({ v: null, h: null })
  /** 拖拽时用到的几何快照（避免拖动过程中反复重算导致抖动） */
  const dragRef = useRef<{
    axis: 'v' | 'h'
    startPos: number
    startScroll: number
    ratio: number
  } | null>(null)

  /** 从真实滚动容器读出几何，换算成两条滑块的位置 */
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

    // 值没变就不 setState：滚动时每帧都会调 sync，无脑重渲染纯属浪费
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

  /** 滚动时短暂显示滑块 */
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
    // 内容尺寸变化（打字、折叠、换语言）与容器尺寸变化都要重算
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

  /** 点轨道翻页（VS Code 同款：点击处翻一屏） */
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
