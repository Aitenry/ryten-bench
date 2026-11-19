import React, { useEffect, useMemo, useRef, useState } from 'react'
import { theme, Empty } from 'antd'
import { RiListCheck2, RiInformationLine } from '@remixicon/react'
import { useEditorState, type Editor } from '@tiptap/react'
import { useTranslation } from '@renderer/i18n'
import dayjs from 'dayjs'

export interface OutlineHeading {
  level: number
  text: string
  pos: number
}

interface OutlinePanelProps {
  editor: Editor | null
  /** 编辑器滚动容器（用于滚动监听定位） */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** 文档属性区数据 */
  meta?: {
    tags: string[]
    wordCount: number
    createdAt?: string
    updatedAt?: string
  }
  /** 面板宽度（可拖拽调整） */
  width?: number
}

const OutlinePanel: React.FC<OutlinePanelProps> = ({ editor, scrollRef, meta, width = 236 }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [activePos, setActivePos] = useState<number | null>(null)
  const rafRef = useRef(0)

  /* 从编辑器文档提取标题大纲 */
  const headingsState = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return [] as OutlineHeading[]
      const result: OutlineHeading[] = []
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          result.push({
            level: (node.attrs.level as number) ?? 1,
            text: node.textContent.slice(0, 120),
            pos
          })
        }
        return true
      })
      return result
    }
  })
  const headings = useMemo(() => headingsState ?? [], [headingsState])

  /* ── 滚动同步：高亮当前所在标题 ── */
  useEffect(() => {
    const container = scrollRef.current
    if (!container || headings.length === 0) return
    /* 注意：domAtPos 在节点起始边界（offset 为 0）会退回 contentDOM 而不是标题元素，
       所有标题拿到同一个容器矩形，导致高亮恒为最后一个；必须用 coordsAtPos 取视口坐标 */
    const headingTop = (pos: number): number | null => {
      if (!editor) return null
      const coords = editor.view.coordsAtPos(pos)
      return coords ? coords.top : null
    }
    const compute = (): void => {
      rafRef.current = 0
      const containerTop = container.getBoundingClientRect().top + 96
      let current: number | null = null
      for (const h of headings) {
        const top = headingTop(h.pos)
        if (top == null) continue
        if (top <= containerTop) {
          current = h.pos
        } else {
          break
        }
      }
      setActivePos(current)
    }
    const onScroll = (): void => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(compute)
    }
    compute()
    container.addEventListener('scroll', onScroll)
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [headings, scrollRef, editor])

  /* ── 点击大纲跳转（不改动光标） ── */
  const handleNavigate = (pos: number): void => {
    const container = scrollRef.current
    if (!editor || !container) return
    /* 同样不能用 domAtPos：它返回的是内容容器，scrollIntoView 会滚到文档顶部 */
    const coords = editor.view.coordsAtPos(pos)
    if (!coords) return
    const containerTop = container.getBoundingClientRect().top
    container.scrollTo({
      top: container.scrollTop + (coords.top - containerTop) - 8,
      behavior: 'smooth'
    })
  }

  const tagChips = useMemo(() => meta?.tags ?? [], [meta])

  return (
    <aside
      style={{
        width,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: token.colorBgContainer,
        /* 贴边面板：右上/右下直角，左缘保留圆角与中间主区呼应（与左侧栏对称） */
        borderRadius: '0 12px 12px 0',
        overflow: 'hidden'
      }}
    >
      {/* 大纲 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 38,
            padding: '0 14px',
            fontSize: 12.5,
            fontWeight: 600,
            color: token.colorTextSecondary,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0
          }}
        >
          <RiListCheck2 size={14} style={{ color: token.colorTextTertiary }} />
          {t('notes.outline.title')}
        </div>
        <div
          className="custom-scrollbar"
          style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}
        >
          {headings.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span style={{ fontSize: 12 }}>{t('notes.outline.empty')}</span>}
              style={{ margin: '24px 0' }}
            />
          ) : (
            headings.map((h) => {
              const active = activePos === h.pos
              return (
                <div
                  key={h.pos}
                  onClick={() => handleNavigate(h.pos)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    paddingLeft: 6 + (h.level - 1) * 14,
                    paddingRight: 8,
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12.5,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    color: active ? token.colorPrimary : token.colorTextSecondary,
                    background: active ? token.colorPrimaryBg : 'transparent'
                  }}
                >
                  <span
                    style={{
                      width: 3,
                      height: 3,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: active ? token.colorPrimary : token.colorTextQuaternary
                    }}
                  />
                  <span
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {h.text}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* 属性 */}
      {meta && (
        <div
          style={{
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            padding: '10px 14px 14px',
            flexShrink: 0,
            maxHeight: '42%',
            overflowY: 'auto'
          }}
          className="custom-scrollbar"
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              fontWeight: 600,
              color: token.colorTextSecondary,
              marginBottom: 8
            }}
          >
            <RiInformationLine size={14} style={{ color: token.colorTextTertiary }} />
            {t('notes.term.properties')}
          </div>
          {tagChips.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {tagChips.map((tag) => (
                <span
                  key={tag}
                  style={{
                    fontSize: 11,
                    padding: '1px 8px',
                    borderRadius: 10,
                    background: token.colorPrimaryBg,
                    color: token.colorPrimary,
                    lineHeight: '18px'
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <MetaRow
              token={token}
              label={t('notes.outline.wordCount')}
              value={`${meta.wordCount ?? 0}`}
            />
            {meta.createdAt && (
              <MetaRow
                token={token}
                label={t('notes.outline.created')}
                value={dayjs(meta.createdAt).format('YYYY-MM-DD HH:mm')}
              />
            )}
            {meta.updatedAt && (
              <MetaRow
                token={token}
                label={t('notes.outline.updated')}
                value={dayjs(meta.updatedAt).format('YYYY-MM-DD HH:mm')}
              />
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

const MetaRow: React.FC<{
  token: ReturnType<typeof theme.useToken>['token']
  label: string
  value: string
}> = ({ token, label, value }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
    <span style={{ color: token.colorTextTertiary, flexShrink: 0, width: 32 }}>{label}</span>
    <span
      style={{
        color: token.colorTextSecondary,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {value}
    </span>
  </div>
)

export default OutlinePanel
