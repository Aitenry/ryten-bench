import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Empty, theme } from 'antd'
import { SkeletonListRows } from '@renderer/components/system/Skeleton'
import { RiBook2Line, RiFolder2Line } from '@remixicon/react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { notesApi } from '../../api/notes'
import type { DocListItem, WikiDirectoryRow, WikiRow } from '../../../../shared/notes/types'

interface ArchiveDocModalProps {
  open: boolean
  doc: DocListItem | null
  wikis: WikiRow[]
  onArchived: () => void
  onClose: () => void
}

/**
 * Archive a document into a knowledge-base directory (standalone modal).
 */
const ArchiveDocModal: React.FC<ArchiveDocModalProps> = ({
  open,
  doc,
  wikis,
  onArchived,
  onClose
}) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()

  const itemStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 10px',
    borderRadius: 7,
    cursor: 'pointer',
    marginBottom: 4,
    fontSize: 13,
    background: active ? token.colorPrimaryBg : 'transparent',
    color: active ? token.colorPrimary : token.colorText
  })

  const [selectedWikiId, setSelectedWikiId] = useState<number | null>(null)
  const [directories, setDirectories] = useState<WikiDirectoryRow[]>([])
  const [selectedDirId, setSelectedDirId] = useState<number | null>(null)
  const [dirsLoading, setDirsLoading] = useState(false)
  /* Request sequence: only accept the response of the latest request (fixes slow responses
     overwriting the newer list when switching knowledge bases quickly) */
  const dirsReqSeqRef = useRef(0)

  /* Reset */
  useEffect(() => {
    if (open) {
      setSelectedWikiId(null)
      setDirectories([])
      setSelectedDirId(null)
    }
  }, [open])

  const handleSelectWiki = useCallback(async (wikiId: number): Promise<void> => {
    const reqSeq = dirsReqSeqRef.current + 1
    dirsReqSeqRef.current = reqSeq
    setSelectedWikiId(wikiId)
    setSelectedDirId(null)
    setDirsLoading(true)
    try {
      const dirs = await notesApi.wikis.getDirectories(wikiId)
      // Drop stale responses (fixes the case where A is clicked first with a slow response and
      // B quickly, and then A's directory list overwrites B's)
      if (dirsReqSeqRef.current !== reqSeq) return
      setDirectories(dirs)
    } catch (error) {
      console.error('Failed to load directories:', error)
    } finally {
      if (dirsReqSeqRef.current === reqSeq) setDirsLoading(false)
    }
  }, [])

  const handleArchive = useCallback(async (): Promise<void> => {
    if (!doc || selectedDirId == null) return
    const messageKey = 'archive-doc'
    try {
      viewMessage(messageKey, 'loading', t('notes.archive.archiving'))
      await notesApi.wikis.addNoteToDirectory(selectedDirId, doc.id)
      viewMessage(messageKey, 'success', t('notes.archive.success'), 2)
      onArchived()
      onClose()
    } catch (error) {
      console.error('Failed to archive doc:', error)
      viewMessage(messageKey, 'error', t('notes.archive.failed'))
    }
  }, [doc, selectedDirId, viewMessage, onArchived, onClose, t])

  return (
    <Modal
      title={t('notes.archive.title', { name: doc?.title ?? '' })}
      open={open}
      onCancel={onClose}
      onOk={handleArchive}
      okText={t('notes.archive.ok')}
      cancelText={t('common.action.cancel')}
      okButtonProps={{ disabled: selectedDirId == null }}
      width={520}
    >
      <div style={{ display: 'flex', gap: 12, height: 300 }}>
        {/* Knowledge base list */}
        <div
          className="custom-scrollbar"
          style={{
            flex: 1,
            overflowY: 'auto',
            borderRight: '1px solid rgba(128,128,128,0.18)',
            paddingRight: 8
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
            {t('notes.archive.stepWiki')}
          </div>
          {wikis.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notes.wiki.empty')} />
          ) : (
            wikis.map((wiki) => {
              const active = selectedWikiId === wiki.id
              return (
                <div
                  key={wiki.id}
                  onClick={() => handleSelectWiki(wiki.id)}
                  style={itemStyle(active)}
                >
                  <RiBook2Line size={13} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {wiki.title}
                  </span>
                </div>
              )
            })
          )}
        </div>
        {/* Directory list */}
        <div className="custom-scrollbar app-modal-scroll" style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
            {t('notes.archive.stepDirectory')}
          </div>
          {selectedWikiId == null ? (
            <div style={{ color: token.colorTextTertiary, fontSize: 12.5 }}>
              {t('notes.archive.selectWikiFirst')}
            </div>
          ) : dirsLoading ? (
            /* Directory rows match the final list height, so there is no jump from a centered
               spinner to a suddenly appearing list while loading */
            <SkeletonListRows rows={4} icon />
          ) : directories.length === 0 ? (
            <div style={{ color: token.colorTextTertiary, fontSize: 12.5 }}>
              {t('notes.archive.noDirectories')}
            </div>
          ) : (
            directories.map((dir) => {
              const active = selectedDirId === dir.id
              return (
                <div
                  key={dir.id}
                  onClick={() => setSelectedDirId(dir.id)}
                  style={itemStyle(active)}
                >
                  <RiFolder2Line size={13} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {dir.name}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}

export default ArchiveDocModal
