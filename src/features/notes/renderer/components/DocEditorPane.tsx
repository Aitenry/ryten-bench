import React, { useCallback, useEffect, useRef, useState } from 'react'
import { theme, Input, Empty, Tag } from 'antd'
import { SkeletonDocPane } from '@renderer/components/system/Skeleton'
import type { InputRef } from 'antd'
import {
  RiCheckLine,
  RiLoader2Line,
  RiErrorWarningLine,
  RiEditLine,
  RiSettings3Line
} from '@remixicon/react'
import type { Editor } from '@tiptap/react'
import TipTapMarkdownEditor from '@renderer/components/markdown/TipTapMarkdownEditor'
import DocPropertiesModal from './DocPropertiesModal'
import { getTagsArray } from '@renderer/utils/document'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { notesApi } from '../api'
import { subscribeDocChanged } from '../doc-changed'
import dayjs from 'dayjs'

interface DocEditorPaneProps {
  docId: number
  /** 保存成功后回调（用于更新列表标题等） */
  onSaved: (docId: number, title: string) => void
  /** 元信息变化回调（驱动右侧属性面板） */
  onMetaChange: (meta: DocMeta | null) => void
  /** 编辑器实例就绪（驱动右侧大纲） */
  onEditorReady: (editor: Editor | null) => void
  /** 正文滚动容器（驱动大纲滚动同步，由父级持有引用） */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** 挂载后聚焦标题输入框（新建文档场景） */
  autofocusTitle?: boolean
}

export interface DocMeta {
  tags: string[]
  wordCount: number
  createdAt?: string
  updatedAt?: string
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

const AUTO_SAVE_DELAY = 1500

const DocEditorPane: React.FC<DocEditorPaneProps> = ({
  docId,
  onSaved,
  onMetaChange,
  onEditorReady,
  scrollRef,
  autofocusTitle = false
}) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [summary, setSummary] = useState<string | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [createdAt, setCreatedAt] = useState<string | undefined>(undefined)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [propsOpen, setPropsOpen] = useState(false)

  const titleInputRef = useRef<InputRef | null>(null)
  const titleFocusedRef = useRef(false)

  /* 新建文档：加载完成后聚焦标题（全部选中便于直接改名） */
  useEffect(() => {
    if (autofocusTitle && !loading && !notFound && !titleFocusedRef.current) {
      titleFocusedRef.current = true
      const el = titleInputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    }
  }, [autofocusTitle, loading, notFound])

  /* 回调 ref */
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const onMetaChangeRef = useRef(onMetaChange)
  onMetaChangeRef.current = onMetaChange

  /* 保存相关内容 ref（避免闭包过期） */
  const docIdRef = useRef(docId)
  docIdRef.current = docId
  const titleRef = useRef(title)
  titleRef.current = title
  const contentRef = useRef(content)
  contentRef.current = content
  const lastSavedRef = useRef<{ title: string; content: string } | null>(null)
  const metaRef = useRef<DocMeta | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false)

  /* ── 加载文档 ── */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setSaveState('saved')
    setLastSavedAt(null)
    lastSavedRef.current = null
    ;(async () => {
      try {
        const doc = await notesApi.docs.getById(docId)
        if (cancelled) return
        if (!doc) {
          setNotFound(true)
          return
        }
        setTitle(doc.title ?? '')
        setContent(doc.content ?? '')
        setTags(getTagsArray(doc.tags))
        setSummary(doc.summary)
        setImage(doc.image)
        // created_at / updated_at 库列为可空（DEFAULT NOW()），缺失时按 undefined 处理
        setCreatedAt(doc.created_at ?? undefined)
        lastSavedRef.current = { title: doc.title ?? '', content: doc.content ?? '' }
        metaRef.current = {
          tags: getTagsArray(doc.tags),
          wordCount: doc.word_count ?? 0,
          createdAt: doc.created_at ?? undefined,
          updatedAt: doc.updated_at ?? undefined
        }
        onMetaChangeRef.current(metaRef.current)
      } catch (error) {
        console.error('Failed to load doc:', error)
        if (!cancelled) setNotFound(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      /* 卸载（切换文档）时若还有未保存修改，立即冲刷一次 */
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const flush = async (): Promise<void> => {
        // 修复：此前冲刷与在途 doSave 并发双写（无版本号/序号，旧快照可能后到覆盖新内容）；
        // 现在先等在途保存结束，再按最新内容补写；冲刷失败也提示
        while (savingRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const last = lastSavedRef.current
        const curTitle = titleRef.current
        const curContent = contentRef.current
        if (last && (curTitle !== last.title || curContent !== last.content)) {
          try {
            await notesApi.docs.update(docId, {
              title: curTitle || t('notes.doc.untitled'),
              content: curContent
            })
          } catch (err) {
            console.error('Failed to flush doc on unmount:', err)
          }
        }
      }
      void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  /* ── 外部修改同步（修复：此前对工具写入完全无感知,继续编辑会把工具刚写入的内容整体覆盖）──
     事件源是 harness 插件（它把主进程的「文档被 AI 改写」桥接成宿主事件总线的 doc:changed），
     本组件只订阅本插件的模块级中转（../doc-changed）——不认识任何插件的通道名或 API。 */
  useEffect(() => {
    const unsubscribe = subscribeDocChanged((data) => {
      if (data.docId !== docIdRef.current) return
      if (data.action === 'deleted') {
        setNotFound(true)
        return
      }
      const last = lastSavedRef.current
      const dirty =
        last != null && (titleRef.current !== last.title || contentRef.current !== last.content)
      if (dirty) {
        // 本地有未保存修改：不覆盖本地,仅提示（用户保存会覆盖工具写入,属已知取舍）
        console.warn(`文档 [${data.docId}] 被聊天工具修改,本地存在未保存编辑,保留本地内容`)
        return
      }
      // 未修改：直接重载工具写入的最新内容
      void (async () => {
        try {
          const doc = await notesApi.docs.getById(data.docId)
          if (!doc || docIdRef.current !== data.docId) return
          setTitle(doc.title ?? '')
          setContent(doc.content ?? '')
          lastSavedRef.current = { title: doc.title ?? '', content: doc.content ?? '' }
        } catch (err) {
          console.error('Failed to reload doc after tool update:', err)
        }
      })()
    })
    return unsubscribe
  }, [])

  /* ── 保存 ── */
  const doSave = useCallback(async (): Promise<void> => {
    const id = docIdRef.current
    const nextTitle = titleRef.current
    const c = contentRef.current
    const last = lastSavedRef.current
    if (last && nextTitle === last.title && c === last.content) {
      setSaveState('saved')
      return
    }
    if (savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    try {
      await notesApi.docs.update(id, { title: nextTitle || t('notes.doc.untitled'), content: c })
      lastSavedRef.current = { title: nextTitle, content: c }
      setSaveState('saved')
      setLastSavedAt(new Date())
      onSavedRef.current(id, nextTitle || t('notes.doc.untitled'))
      metaRef.current = metaRef.current
        ? {
            ...metaRef.current,
            wordCount: (c.match(/[^\s]/g) ?? []).length,
            updatedAt: new Date().toISOString()
          }
        : null
      if (metaRef.current) onMetaChangeRef.current(metaRef.current)
    } catch (error) {
      console.error('Failed to save doc:', error)
      setSaveState('error')
    } finally {
      savingRef.current = false
      // 修复：保存期间的新编辑此前被 savingRef 静默吞掉（timer 已消耗且无重排，
      // 状态还被置回「已保存」而 DB 里根本没有这些编辑）——完成后若仍有未落库修改，
      // 立即补排一次保存
      const lastNow = lastSavedRef.current
      const cur = { title: titleRef.current, content: contentRef.current }
      if (lastNow && (cur.title !== lastNow.title || cur.content !== lastNow.content)) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
          doSave().then()
        }, AUTO_SAVE_DELAY)
      }
    }
  }, [t])

  /* 内容/标题变化 → 标记未保存并启动自动保存 */
  const markChanged = useCallback(() => {
    const last = lastSavedRef.current
    if (last && titleRef.current === last.title && contentRef.current === last.content) {
      setSaveState('saved')
      return
    }
    setSaveState('dirty')
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      doSave().then()
    }, AUTO_SAVE_DELAY)
  }, [doSave])

  const handleContentChange = useCallback(
    (md: string) => {
      contentRef.current = md
      setContent(md)
      markChanged()
    },
    [markChanged]
  )

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      titleRef.current = value
      setTitle(value)
      markChanged()
    },
    [markChanged]
  )

  const handleSaveNow = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    doSave().then()
  }, [doSave])

  const handleEditorReady = useCallback(
    (editor: Editor) => {
      onEditorReady(editor)
    },
    [onEditorReady]
  )

  /* ── 保存文档属性（标签/摘要/封面） ── */
  const handlePropsSave = useCallback(
    async (data: {
      image: string | null
      summary: string | null
      tags: string[]
    }): Promise<void> => {
      const messageKey = 'doc-props-save'
      try {
        await notesApi.docs.update(docIdRef.current, {
          image: data.image,
          summary: data.summary,
          tags: data.tags.length > 0 ? JSON.stringify(data.tags) : null
        })
        setTags(data.tags)
        setSummary(data.summary)
        setImage(data.image)
        metaRef.current = metaRef.current
          ? { ...metaRef.current, tags: data.tags }
          : metaRef.current
        if (metaRef.current) onMetaChangeRef.current(metaRef.current)
        onSavedRef.current(docIdRef.current, titleRef.current || t('notes.doc.untitled'))
        viewMessage(messageKey, 'success', t('notes.doc.propsSaved'), 2)
      } catch (error) {
        console.error('Failed to save doc properties:', error)
        viewMessage(messageKey, 'error', t('notes.doc.propsSaveFailed'))
      }
    },
    [viewMessage, t]
  )

  /* 卸载时清理 onEditorReady */
  useEffect(() => {
    return () => onEditorReady(null)
  }, [onEditorReady])

  if (loading) {
    return (
      <PaneShell>
        {/* 标题 / 元信息 / 段落先铺出来，文档到位后原地替换，避免整块空白 */}
        <SkeletonDocPane />
      </PaneShell>
    )
  }

  if (notFound) {
    return (
      <PaneShell>
        <Empty description={t('notes.doc.notFound')} style={{ marginTop: 120 }} />
      </PaneShell>
    )
  }

  const saveIndicator = ((): React.ReactNode => {
    switch (saveState) {
      case 'saving':
        return (
          <>
            <RiLoader2Line size={13} className="spin-anim" style={{ color: token.colorPrimary }} />
            <span style={{ color: token.colorTextSecondary }}>{t('notes.editor.saving')}</span>
          </>
        )
      case 'dirty':
        return (
          <>
            <RiEditLine size={13} style={{ color: token.colorTextTertiary }} />
            <span style={{ color: token.colorTextTertiary }}>{t('notes.editor.unsaved')}</span>
          </>
        )
      case 'error':
        return (
          <>
            <RiErrorWarningLine size={13} style={{ color: token.colorError }} />
            <span style={{ color: token.colorError }}>{t('common.action.saveFailed')}</span>
          </>
        )
      default:
        return (
          <>
            <RiCheckLine size={13} style={{ color: token.colorSuccess }} />
            <span style={{ color: token.colorTextTertiary }}>
              {lastSavedAt
                ? t('notes.editor.savedWithTime', { time: dayjs(lastSavedAt).format('HH:mm:ss') })
                : t('notes.editor.saved')}
            </span>
          </>
        )
    }
  })()

  return (
    <PaneShell>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          height: '100%',
          maxWidth: 876,
          width: '100%',
          margin: '0 auto'
        }}
      >
        {/* 标题 + 元信息（不随正文滚动） */}
        <div style={{ padding: '17px 17px 0', flexShrink: 0 }}>
          <Input
            ref={titleInputRef}
            variant="borderless"
            value={title}
            onChange={handleTitleChange}
            placeholder={t('notes.doc.untitled')}
            maxLength={120}
            style={{
              fontSize: 24,
              fontWeight: 700,
              padding: 0,
              letterSpacing: -0.01
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginTop: 8,
              fontSize: 12,
              color: token.colorTextTertiary,
              flexWrap: 'wrap'
            }}
          >
            {createdAt && (
              <span>
                {t('notes.doc.createdAt', { date: dayjs(createdAt).format('YYYY-MM-DD') })}
              </span>
            )}
            {tags.length > 0 && (
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {tags.map((tag) => (
                  <Tag
                    key={tag}
                    variant="filled"
                    style={{
                      margin: 0,
                      fontSize: 11,
                      lineHeight: '18px',
                      padding: '0 8px',
                      borderRadius: 9,
                      background: token.colorPrimaryBg,
                      color: token.colorPrimary
                    }}
                  >
                    {tag}
                  </Tag>
                ))}
              </span>
            )}
            <span
              onClick={() => setPropsOpen(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
                padding: '1px 8px',
                borderRadius: 6,
                color: token.colorTextTertiary,
                background: 'transparent',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = token.colorFillTertiary
                e.currentTarget.style.color = token.colorTextSecondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = token.colorTextTertiary
              }}
            >
              <RiSettings3Line size={12} />
              {t('notes.term.properties')}
            </span>
          </div>
        </div>

        {/* 编辑器（自带滚动；文档加载完成后才挂载，避免空内容闪烁） */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            ['--ed-body-pad-top' as string]: '20px'
          }}
        >
          {!loading && !notFound && (
            <TipTapMarkdownEditor
              key={docId}
              value={content}
              onChange={handleContentChange}
              onSave={() => handleSaveNow()}
              onReady={handleEditorReady}
              scrollRef={scrollRef}
            />
          )}
        </div>

        {/* 底部状态条 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 16px',
            flexShrink: 0,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            fontSize: 12
          }}
        >
          {saveIndicator}
          <span style={{ flex: 1 }} />
          <span style={{ color: token.colorTextQuaternary, fontSize: 11 }}>
            {t('notes.editor.hint')}
          </span>
        </div>
      </div>

      {/* 文档属性小弹窗（标签/摘要/封面） */}
      <DocPropertiesModal
        open={propsOpen}
        doc={{ title, summary, tags: JSON.stringify(tags), image }}
        onClose={() => setPropsOpen(false)}
        onSave={handlePropsSave}
      />
    </PaneShell>
  )
}

/* ──────────── 外壳 ──────────── */

const PaneShell: React.FC<{
  children: React.ReactNode
}> = ({ children }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      display: 'flex',
      /* 卡片外壳已由中间主区容器提供，这里只承担布局 */
      overflow: 'hidden'
    }}
  >
    {children}
  </div>
)

export default DocEditorPane
