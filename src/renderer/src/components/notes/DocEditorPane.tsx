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
import { notesApi } from '../../api/notes'
import { subscribeDocChanged } from '../../events/doc-changed'
import dayjs from 'dayjs'

interface DocEditorPaneProps {
  docId: number
  /** Called after a successful save (e.g. to update the list title) */
  onSaved: (docId: number, title: string) => void
  /** Meta change callback (drives the properties panel on the right) */
  onMetaChange: (meta: DocMeta | null) => void
  /** Editor instance ready (drives the outline on the right) */
  onEditorReady: (editor: Editor | null) => void
  /** Body scroll container (drives outline scroll sync; the parent holds the ref) */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Focus the title input after mount (new document case) */
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

  /* New document: focus the title once loading finishes (select all for direct renaming) */
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

  /* Callback refs */
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const onMetaChangeRef = useRef(onMetaChange)
  onMetaChangeRef.current = onMetaChange

  /* Save-related refs (avoid stale closures) */
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

  /* ── Load document ── */
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
        // created_at / updated_at columns are nullable (DEFAULT NOW()); missing → undefined
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
      /* On unmount (switching documents), immediately flush any unsaved changes */
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const flush = async (): Promise<void> => {
        // Fix: the flush used to race an in-flight doSave and write twice (no version or sequence
        // number, so an older snapshot could arrive later and overwrite newer content). Now we wait
        // for the in-flight save to finish, then re-write the latest content; flush failures are reported
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
            // Honor the promise made in the comment above: a failed flush must be surfaced, otherwise
            // switching documents silently loses the body text
            viewMessage('doc-flush-save', 'error', t('notes.doc.flushFailed'))
          }
        }
      }
      void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  /* ── External modification sync (fix: tool writes were previously ignored entirely, so continued
      editing overwrote whatever the tool had just written).
      The event source is the harness plugin (it bridges the main process's "document rewritten by AI"
      to the host event bus as doc:changed); this component only subscribes to this plugin's
      module-level relay (../doc-changed) — it knows no other plugin's channel names or API. */
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
        // Local edits are unsaved: do not overwrite local content, just warn (saving later overwrites
        // the tool's write — a known tradeoff)
        console.warn(`Document [${data.docId}] was modified by a chat tool, keeping local content with unsaved edits`)
        return
      }
      // No local edits: reload the latest content written by the tool
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

  /* ── Save ── */
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
      // Fix: edits made during a save used to be silently swallowed by savingRef (the timer had
      // already fired with no reschedule, and the state was set back to "saved" while those edits
      // were never in the DB). After finishing, if unsaved changes remain, schedule another save
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

  /* Content/title changed → mark unsaved and start auto-save */
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

  /* ── Save document properties (tags/summary/cover) ── */
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

  /* Clear onEditorReady on unmount */
  useEffect(() => {
    return () => onEditorReady(null)
  }, [onEditorReady])

  if (loading) {
    return (
      <PaneShell>
        {/* Render the title / meta / paragraphs up front, then replace in place once the doc
            arrives, to avoid a full blank block */}
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
        {/* Title + meta (does not scroll with the body) */}
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

        {/* Editor (scrolls on its own; mounted only after the doc loads to avoid empty-content flicker) */}
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

        {/* Bottom status bar */}
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

      {/* Small doc-properties dialog (tags/summary/cover) */}
      <DocPropertiesModal
        open={propsOpen}
        doc={{ title, summary, tags: JSON.stringify(tags), image }}
        onClose={() => setPropsOpen(false)}
        onSave={handlePropsSave}
      />
    </PaneShell>
  )
}

/* ──────────── Shell ──────────── */

const PaneShell: React.FC<{
  children: React.ReactNode
}> = ({ children }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      display: 'flex',
      /* The card shell is provided by the middle main-area container; this only handles layout */
      overflow: 'hidden'
    }}
  >
    {children}
  </div>
)

export default DocEditorPane
