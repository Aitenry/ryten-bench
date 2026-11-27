import { Node, mergeAttributes } from '@tiptap/core'
import type { NodeViewRenderer, NodeViewRendererProps } from '@tiptap/core'
import type MarkdownIt from 'markdown-it'
import { i18n } from '@renderer/i18n'

/* ════════════════════════════════════════════════════════════
   Mermaid 图表适配：```mermaid 代码块渲染为可交互图表
   - fence 规则把 ```mermaid 渲染成 <pre data-mermaid>，mermaid 节点承接
   - mermaid 为原子节点（attrs.code），NodeView 默认显示渲染图，
     工具栏（纯图标）切换为 textarea 原地编辑
   - 序列化保持 ```mermaid 围栏，与解析完全往返
   - 渲染 util 同时供只读预览（MermaidDiagram.tsx）复用
   ════════════════════════════════════════════════════════════ */

/* ── 工具栏图标（remixicon path，纯图标无文字） ── */
const ICON_CODE = // RiCodeBoxLine：编辑源码
  'M3 3H21C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3ZM4 5V19H20V5H4ZM20 12L16.4645 15.5355L15.0503 14.1213L17.1716 12L15.0503 9.87868L16.4645 8.46447L20 12ZM6.82843 12L8.94975 14.1213L7.53553 15.5355L4 12L7.53553 8.46447L8.94975 9.87868L6.82843 12ZM11.2443 17H9.11597L12.7557 7H14.884L11.2443 17Z'
const ICON_FLOW = // RiFlowChart：返回图表
  'M6 21.5C4.067 21.5 2.5 19.933 2.5 18C2.5 16.067 4.067 14.5 6 14.5C7.5852 14.5 8.92427 15.5539 9.35481 16.9992L15 16.9994V15L17 14.9994V9.24339L14.757 6.99938H9V9.00003H3V3.00003H9V4.99939H14.757L18 1.75739L22.2426 6.00003L19 9.24139V14.9994L21 15V21H15V18.9994L9.35499 19.0003C8.92464 20.4459 7.58543 21.5 6 21.5ZM6 16.5C5.17157 16.5 4.5 17.1716 4.5 18C4.5 18.8285 5.17157 19.5 6 19.5C6.82843 19.5 7.5 18.8285 7.5 18C7.5 17.1716 6.82843 16.5 6 16.5ZM19 17H17V19H19V17ZM18 4.58581L16.5858 6.00003L18 7.41424L19.4142 6.00003L18 4.58581ZM7 5.00003H5V7.00003H7V5.00003Z'
const ICON_REFRESH = // RiRefreshLine：重新渲染
  'M5.46257 4.43262C7.21556 2.91688 9.5007 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C9.84982 4 7.89777 4.84827 6.46023 6.22842L5.46257 4.43262ZM18.5374 19.5674C16.7844 21.0831 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 9.86386 2.66979 7.88416 3.8108 6.25944L7 12H4C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z'
const ICON_CENTER = // RiFocus3Line：居中画布
  'M13 1L13.001 4.06201C16.6192 4.51365 19.4869 7.38163 19.9381 11L23 11V13L19.938 13.001C19.4864 16.6189 16.6189 19.4864 13.001 19.938L13 23H11L11 19.9381C7.38163 19.4869 4.51365 16.6192 4.06201 13.001L1 13V11L4.06189 11C4.51312 7.38129 7.38129 4.51312 11 4.06189L11 1H13ZM12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6ZM12 10C13.1046 10 14 10.8954 14 12C14 13.1046 13.1046 14 12 14C10.8954 14 10 13.1046 10 12C10 10.8954 10.8954 10 12 10Z'
const ICON_FULLSCREEN = // RiFullscreenLine：全屏窗口预览
  'M8 3V5H4V9H2V3H8ZM2 21V15H4V19H8V21H2ZM22 21H16V19H20V15H22V21ZM22 9H20V5H16V3H22V9Z'

/** 创建内联 SVG 图标（fill 继承 currentColor） */
function createIcon(d: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  return svg
}

let mermaidModule: Promise<typeof import('mermaid')> | null = null
let diagramSeq = 0

function getMermaidModule(): Promise<typeof import('mermaid')> {
  if (!mermaidModule) mermaidModule = import('mermaid')
  return mermaidModule
}

/** 渲染 Mermaid 源码为 SVG 字符串（mermaid 包懒加载，主题跟随明暗） */
export async function renderMermaidDiagram(code: string, isDark: boolean): Promise<string> {
  const { default: mermaid } = await getMermaidModule()
  const theme = isDark ? 'dark' : 'default'
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    fontFamily: 'inherit'
  })
  const id = `ryten-mermaid-${(++diagramSeq).toString(36)}`
  // mermaid.render 不传容器时会把临时 div（d<id>）直接挂到 document.body 末尾，
  // 渲染期间该 div 按图表自然宽度撑爆 body → 最外层 xy 滚动条瞬现，渲染完移除。
  // 传一个屏幕外零影响的容器隔离渲染，临时 div 永远不进入 body。
  const container = document.createElement('div')
  container.style.cssText =
    'position: fixed; left: -10000px; top: -10000px; width: 2000px; height: 2000px; overflow: hidden;'
  document.body.appendChild(container)
  try {
    const { svg } = await mermaid.render(id, code, container)
    return svg
  } finally {
    container.remove()
  }
}

/* ──────────── NodeView：图表 / 源码双模式 ──────────── */

function createMermaidNodeView(props: NodeViewRendererProps): ReturnType<NodeViewRenderer> {
  const dom = document.createElement('div')
  dom.className = 'tiptap-mermaid'

  const bar = document.createElement('div')
  bar.className = 'tiptap-mermaid-bar'

  const label = document.createElement('span')
  label.className = 'tiptap-mermaid-label'
  label.textContent = i18n.t('markdown.mermaid.label')

  const btnEdit = document.createElement('button')
  btnEdit.type = 'button'
  btnEdit.className = 'tiptap-mermaid-btn'
  btnEdit.title = i18n.t('markdown.mermaid.editSource')

  const btnRefresh = document.createElement('button')
  btnRefresh.type = 'button'
  btnRefresh.className = 'tiptap-mermaid-btn'
  btnRefresh.title = i18n.t('common.action.refresh')

  /* 编辑/图表模式切换：按钮图标与悬浮提示同步换 */
  const setEditIcon = (icon: SVGSVGElement, title: string): void => {
    btnEdit.textContent = ''
    btnEdit.appendChild(icon)
    btnEdit.title = title
  }
  setEditIcon(createIcon(ICON_CODE), i18n.t('markdown.mermaid.editSource'))
  btnRefresh.appendChild(createIcon(ICON_REFRESH))

  const btnCenter = document.createElement('button')
  btnCenter.type = 'button'
  btnCenter.className = 'tiptap-mermaid-btn'
  btnCenter.title = i18n.t('markdown.mermaid.centerCanvas')
  btnCenter.appendChild(createIcon(ICON_CENTER))

  const btnFullscreen = document.createElement('button')
  btnFullscreen.type = 'button'
  btnFullscreen.className = 'tiptap-mermaid-btn'
  btnFullscreen.title = i18n.t('markdown.mermaid.fullscreen')
  btnFullscreen.appendChild(createIcon(ICON_FULLSCREEN))

  bar.append(label, btnCenter, btnFullscreen, btnEdit, btnRefresh)

  const prevent = (e: MouseEvent): void => e.preventDefault()

  /* 画布：viewport 为变换层（translate+scale），支持拖拽平移与滚轮缩放 */
  const canvas = document.createElement('div')
  canvas.className = 'tiptap-mermaid-canvas'
  const viewport = document.createElement('div')
  viewport.className = 'tiptap-mermaid-viewport'
  canvas.appendChild(viewport)

  dom.append(bar, canvas)

  let editing = false
  let destroyed = false
  let renderSeq = 0
  let renderTimer: number | null = null
  let textarea: HTMLTextAreaElement | null = null

  const getCode = (): string => (props.node.attrs.code as string) ?? ''

  /* ── 视图状态：tx/ty 平移、scale 缩放（锚定光标） ── */
  const view = { tx: 0, ty: 0, scale: 1 }
  const MIN_SCALE = 0.2
  const MAX_SCALE = 5
  const PAD = 14 // 与 CSS .tiptap-mermaid-viewport padding 一致
  /** 画布可见区域高度上限（超出时 SVG 缩放适配） */
  const MAX_CANVAS_HEIGHT = Math.min(window.innerHeight * 0.6, 520)

  const applyView = (): void => {
    viewport.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`
  }

  /** 内容未缩放时的自然尺寸（按 SVG viewBox，不被 width=100% 拉伸） */
  const contentSize = (): { sw: number; sh: number } => {
    const svg = viewport.querySelector('svg')
    const vb = svg?.viewBox?.baseVal
    if (svg && vb && vb.width > 0 && vb.height > 0) {
      return { sw: vb.width, sh: vb.height }
    }
    return { sw: viewport.clientWidth - 2 * PAD, sh: viewport.clientHeight - 2 * PAD }
  }

  /** 渲染后让 SVG 按自然尺寸（viewBox）布局，覆盖 mermaid 输出的 width="100%" */
  const applyNaturalSize = (): void => {
    const svg = viewport.querySelector('svg')
    const vb = svg?.viewBox?.baseVal
    if (svg && vb && vb.width > 0 && vb.height > 0) {
      svg.style.width = `${vb.width}px`
      svg.style.height = `${vb.height}px`
    }
  }

  /**
   * 适配视图：把 SVG 等比缩放到画布可见区域内（基于自然尺寸），并居中。
   * 画布高度按内容收缩，但不超过 MAX_CANVAS_HEIGHT。
   * 居中偏移减 PAD*scale：svg 距变换原点（viewport 左上角）的 padding 偏移
   * 也会被 scale 放大，固定减 PAD 会在缩放状态下产生偏差。
   */
  const fitView = (): void => {
    const { sw, sh } = contentSize()
    const canvasH = Math.min(sh + 2 * PAD, MAX_CANVAS_HEIGHT)
    canvas.style.height = `${canvasH}px`
    const availW = Math.max(1, canvas.clientWidth - 2 * PAD)
    const availH = Math.max(1, canvasH - 2 * PAD)
    view.scale = Math.min(1, availW / Math.max(1, sw), availH / Math.max(1, sh))
    view.tx = (canvas.clientWidth - sw * view.scale) / 2 - PAD * view.scale
    view.ty = (canvasH - sh * view.scale) / 2 - PAD * view.scale
    applyView()
  }

  /** 保持当前缩放，把内容平移到画布中心 */
  const centerView = (): void => {
    const { sw, sh } = contentSize()
    view.tx = (canvas.clientWidth - sw * view.scale) / 2 - PAD * view.scale
    view.ty = (canvas.clientHeight - sh * view.scale) / 2 - PAD * view.scale
    applyView()
  }

  /* 窗口/布局尺寸变化（含最大化）后重新适配，避免内容停留在旧布局位置 */
  let lastCanvasSize = { w: 0, h: 0 }
  const onCanvasResize = (): void => {
    if (editing || destroyed) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === lastCanvasSize.w && h === lastCanvasSize.h) return
    lastCanvasSize = { w, h }
    fitView()
  }
  const resizeObserver = new ResizeObserver(onCanvasResize)
  resizeObserver.observe(canvas)

  /* 滚轮：以光标为锚点缩放 */
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * Math.exp(-e.deltaY * 0.0015)))
    const k = next / view.scale
    view.tx = mx - (mx - view.tx) * k
    view.ty = my - (my - view.ty) * k
    view.scale = next
    applyView()
  }
  canvas.addEventListener('wheel', onWheel, { passive: false })

  /* 拖拽平移 */
  let drag: { sx: number; sy: number; tx: number; ty: number } | null = null
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0 || editing) return
    e.preventDefault()
    drag = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty }
    canvas.classList.add('tiptap-mermaid-dragging')
  }
  const onMouseMove = (e: MouseEvent): void => {
    if (!drag) return
    view.tx = drag.tx + (e.clientX - drag.sx)
    view.ty = drag.ty + (e.clientY - drag.sy)
    applyView()
  }
  const onMouseUp = (): void => {
    if (!drag) return
    drag = null
    canvas.classList.remove('tiptap-mermaid-dragging')
  }
  canvas.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)

  /* 双击画布：重置适配视图 */
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault()
    fitView()
  })

  /* 全屏窗口预览（复用 mermaid 输出的 SVG，同样画布效果） */
  btnFullscreen.addEventListener('mousedown', prevent)
  btnFullscreen.addEventListener('click', () => {
    const svgEl = viewport.querySelector('svg')
    if (!svgEl) return
    void window.api.mermaid.preview(svgEl.outerHTML)
  })

  btnCenter.addEventListener('mousedown', prevent)
  btnCenter.addEventListener('click', () => centerView())

  /* 已渲染的内容：update() 在任意事务后都会触发，内容没变就不重渲染，
     避免每次键入都清空画布重画（高度塌陷 → 滚动条/滚动位置跳动） */
  let lastRenderedCode: string | null = null

  const renderDiagram = (): void => {
    const code = getCode()
    if (code === lastRenderedCode) return
    const seq = ++renderSeq
    if (renderTimer != null) window.clearTimeout(renderTimer)
    if (!code.trim()) {
      viewport.textContent = i18n.t('markdown.mermaid.empty')
      viewport.classList.remove('tiptap-mermaid-loading')
      canvas.style.height = ''
      lastRenderedCode = code
      return
    }
    // 保留旧图直到新图就绪，避免闪烁
    lastRenderedCode = code
    renderTimer = window.setTimeout(() => {
      void renderMermaidDiagram(code, document.documentElement.classList.contains('dark'))
        .then((svg) => {
          if (destroyed || seq !== renderSeq) return
          viewport.classList.remove('tiptap-mermaid-loading')
          viewport.innerHTML = svg
          applyNaturalSize()
          fitView()
        })
        .catch((error: unknown) => {
          if (destroyed || seq !== renderSeq) return
          viewport.classList.remove('tiptap-mermaid-loading')
          viewport.textContent = ''
          const err = document.createElement('div')
          err.className = 'tiptap-mermaid-error'
          err.textContent = i18n.t('markdown.mermaid.errorWithReason', {
            reason: error instanceof Error ? error.message : String(error)
          })
          viewport.append(err)
        })
    }, 100)
  }

  const commit = (): void => {
    if (!editing || destroyed) return
    const next = (textarea?.value ?? '').replace(/\s+$/, '')
    editing = false
    textarea?.remove()
    textarea = null
    dom.classList.remove('tiptap-mermaid-editing')
    canvas.style.display = ''
    setEditIcon(createIcon(ICON_CODE), i18n.t('markdown.mermaid.editSource'))
    const pos = props.getPos()
    if (pos != null && next !== getCode()) {
      props.editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { code: next })
          return true
        })
        .run()
    }
    renderDiagram()
  }

  const cancel = (): void => {
    if (!editing || destroyed) return
    editing = false
    textarea?.remove()
    textarea = null
    dom.classList.remove('tiptap-mermaid-editing')
    canvas.style.display = ''
    setEditIcon(createIcon(ICON_CODE), i18n.t('markdown.mermaid.editSource'))
    renderDiagram()
  }

  const showSource = (): void => {
    if (editing || destroyed) return
    editing = true
    dom.classList.add('tiptap-mermaid-editing')
    canvas.style.display = 'none'
    setEditIcon(createIcon(ICON_FLOW), i18n.t('markdown.mermaid.backToDiagram'))
    textarea = document.createElement('textarea')
    textarea.className = 'tiptap-mermaid-textarea'
    textarea.value = getCode()
    textarea.rows = Math.max(4, getCode().split('\n').length + 1)
    textarea.spellcheck = false
    textarea.placeholder = i18n.t('markdown.mermaid.placeholder')
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopPropagation()
        commit()
      }
    })
    textarea.addEventListener('blur', (e) => {
      // 焦点只是移到节点内部时不提交，防误触发
      const related = (e as FocusEvent).relatedTarget as globalThis.Node | null
      if (related && dom.contains(related)) return
      commit()
    })
    dom.append(textarea)
    textarea.focus()
  }

  btnEdit.addEventListener('mousedown', prevent)
  btnEdit.addEventListener('click', () => {
    if (editing) commit()
    else showSource()
  })
  btnRefresh.addEventListener('mousedown', prevent)
  btnRefresh.addEventListener('click', () => renderDiagram())
  renderDiagram()

  return {
    dom,
    update(node) {
      props.node = node
      if (!editing) renderDiagram()
      return true
    },
    // 编辑态拦截 PM 事件（textarea 输入由自身处理）；
    // 画布内的拖拽/缩放/双击也全部拦截，不交给 PM
    stopEvent(event) {
      if (editing) return true
      const t = event.target as HTMLElement | null
      if (t && typeof t.closest === 'function' && t.closest('.tiptap-mermaid-canvas')) return true
      return false
    },
    destroy() {
      destroyed = true
      if (renderTimer != null) window.clearTimeout(renderTimer)
      resizeObserver.disconnect()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }
}

/* ──────────── 节点定义 ──────────── */

export const Mermaid = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return { code: { default: '' } }
  },

  parseHTML() {
    return [
      {
        tag: 'pre[data-mermaid]',
        // markdown-it 的 fence content 自带行尾换行（getLines keepLastLF），
        // 与 codeBlock 的 PM 解析行为对齐，去掉末尾单个换行
        getAttrs: (el) => ({ code: ((el as HTMLElement).textContent ?? '').replace(/\n$/, '') })
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-mermaid': '' }),
      ['code', node.attrs.code]
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write('```mermaid\n')
          state.text((node.attrs.code as string) ?? '', false)
          state.write('\n```')
          state.closeBlock(node)
        },
        parse: {
          setup(md: MarkdownIt) {
            // ```mermaid 围栏 → <pre data-mermaid>（其余语言走默认 fence 规则）
            const defaultFence = md.renderer.rules.fence
            md.renderer.rules.fence = (tokens, idx, options, env, self) => {
              const token = tokens[idx]
              const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
              const lang = info.split(/\s+/g)[0] ?? ''
              if (lang === 'mermaid') {
                return `<pre data-mermaid>${md.utils.escapeHtml(token.content)}</pre>`
              }
              return defaultFence
                ? defaultFence(tokens, idx, options, env, self)
                : self.renderToken(tokens, idx, options)
            }
          }
        }
      }
    }
  },

  addNodeView() {
    return createMermaidNodeView
  }
})
