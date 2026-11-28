import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { App, theme, Button, Input, Modal, Spin } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOutlined,
  SearchOutlined
} from '@ant-design/icons'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import EntityCard from '@renderer/components/system/EntityCard'
import MarkdownPreviewModal from '@renderer/components/markdown/MarkdownPreviewModal'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import type { SystemSettings, HarnessSettings } from '@renderer/types/settings'
import {
  SettingsPageHeader,
  SettingsSection
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi } from '../../../api/harness'

interface SkillInfo {
  id: string
  name: string
  description: string
}

interface SkillDetail extends SkillInfo {
  content: string
  raw: string
}

/**
 * Skills page: directory configuration + skill cards.
 *
 * User wording 2026-11-27:
 * - Whether a skill is enabled is still chosen per conversation under the chat input; the skills
 *   page has **no enable switch**;
 * - The skills page only manages: click a card to read SKILL.md, and "Edit / Delete" sits at the
 *   card's bottom-right;
 * - The list is no longer paged: with many skills the card grid scrolls by itself, while the page
 *   title / directory area stay fixed at the top.
 */
const SkillsSettings: React.FC = () => {
  const {
    token: { colorTextTertiary }
  } = theme.useToken()

  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  const [settings, setSettings] = useState<SystemSettings | null>(null)
  /**
   * **Draft** of the directory input: the user may type / browse first; it takes effect only on
   * "Save". The skill list and search only look at the saved `savedSkillsPath` - otherwise every
   * keystroke would rescan the old directory, and the UI would show a mismatch between "input is
   * the new path, list is the old directory".
   */
  const [skillsPathDraft, setSkillsPathDraft] = useState('')
  const savedSkillsPath = settings?.harness?.skillsPath ?? ''
  const [skills, setSkills] = useState<SkillInfo[]>([])
  /** Search term right of the "Discovered skills" title: filters only the current list, does
   * not change the directory / enabled state */
  const [skillQuery, setSkillQuery] = useState('')
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [skillsLoadFailed, setSkillsLoadFailed] = useState(false)
  const [savingPath, setSavingPath] = useState(false)
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0)

  /** View content: open the modal with metadata first, fill in the content when it arrives
   * (disk reads are fast, but keep feedback) */
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const detailRequestRef = useRef(0)

  /** Edit: raw SKILL.md content (including frontmatter) */
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null)
  const [editRaw, setEditRaw] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const [savingSkill, setSavingSkill] = useState(false)
  const editRequestRef = useRef(0)

  const loadSettings = useCallback(async () => {
    const msgKey = 'skills-settings-load'
    try {
      const result = await window.api.systemSettings.getAll()
      setSettings(result)
      setSkillsPathDraft(result.harness?.skillsPath ?? '')
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('common.message.loadFailedWithReason', { reason: String(error) })
      )
    }
  }, [viewMessage, t])

  useEffect(() => {
    loadSettings().then()
  }, [loadSettings])

  // Load all skills when the saved directory is valid: the count is "subdirectories in the local
  // directory", and a page size of 5 would leave one row plus a big empty area on widescreen with
  // later skills unseen; load everything instead (the main process only reads frontmatter).
  useEffect(() => {
    if (!savedSkillsPath) {
      setSkills([])
      setSkillsLoadFailed(false)
      setLoadingSkills(false)
      return
    }
    let cancelled = false
    setLoadingSkills(true)
    setSkillsLoadFailed(false)
    harnessApi.harness
      .listSkills()
      .then((result) => {
        if (!cancelled) setSkills(result)
      })
      .catch(() => {
        if (cancelled) return
        setSkills([])
        setSkillsLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoadingSkills(false)
      })
    return () => {
      cancelled = true
    }
  }, [savedSkillsPath, skillsRefreshKey])

  // The previous search term is meaningless after changing directories; clear it so the new
  // directory does not start with an empty list
  useEffect(() => {
    setSkillQuery('')
  }, [savedSkillsPath])

  /** Search: matches name / directory id / description (same matching rules as the input
   * panel's search) */
  const filteredSkills = useMemo(() => {
    const keyword = skillQuery.trim().toLowerCase()
    if (!keyword) return skills
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(keyword) ||
        skill.id.toLowerCase().includes(keyword) ||
        skill.description.toLowerCase().includes(keyword)
    )
  }, [skills, skillQuery])

  const handleBrowsePath = async (): Promise<void> => {
    try {
      const path = await harnessApi.harness.selectSkillsDirectory()
      if (path) setSkillsPathDraft(path)
    } catch (error) {
      viewMessage(
        'skills-path',
        'error',
        t('common.message.operationFailedWithReason', { reason: String(error) })
      )
    }
  }

  const handleSavePath = async (): Promise<void> => {
    const msgKey = 'skills-path'
    try {
      setSavingPath(true)
      const trimmed = skillsPathDraft.trim()
      const nextHarness: HarnessSettings = {
        ...(settings?.harness ?? {}),
        skillsPath: trimmed || undefined
      }
      await window.api.systemSettings.update({ harness: nextHarness })
      setSettings((prev) => (prev ? { ...prev, harness: nextHarness } : prev))
      setSkillsPathDraft(trimmed)
      setSkillsRefreshKey((k) => k + 1)
      viewMessage(
        msgKey,
        'success',
        trimmed ? t('skillsSettings.savedDir') : t('skillsSettings.clearedDir'),
        2
      )
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('common.message.saveFailedWithReason', { reason: String(error) })
      )
    } finally {
      setSavingPath(false)
    }
  }

  /** Open content: show the modal skeleton first and replace it when loaded; closing or
   * switching skills invalidates the old request */
  const handleOpenDetail = async (skill: SkillInfo): Promise<void> => {
    const requestId = detailRequestRef.current + 1
    detailRequestRef.current = requestId
    setDetail({ ...skill, content: '', raw: '' })
    setDetailLoading(true)
    try {
      const result = await harnessApi.harness.getSkill(skill.id)
      if (detailRequestRef.current !== requestId) return
      if (!result) {
        setDetail(null)
        viewMessage('skills-detail', 'error', t('skillsSettings.detailFailed'))
        return
      }
      setDetail(result)
    } catch (error) {
      if (detailRequestRef.current !== requestId) return
      setDetail(null)
      viewMessage(
        'skills-detail',
        'error',
        t('skillsSettings.detailFailedWithReason', { reason: String(error) })
      )
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false)
    }
  }

  const closeDetail = (): void => {
    detailRequestRef.current += 1
    setDetail(null)
    setDetailLoading(false)
  }

  /** Open edit: fetch the raw SKILL.md (including frontmatter) and write it back unchanged on
   * save */
  const handleOpenEdit = async (skill: SkillInfo): Promise<void> => {
    const requestId = editRequestRef.current + 1
    editRequestRef.current = requestId
    setEditingSkill(skill)
    setEditRaw('')
    setEditLoading(true)
    try {
      const result = await harnessApi.harness.getSkill(skill.id)
      if (editRequestRef.current !== requestId) return
      if (!result) {
        setEditingSkill(null)
        viewMessage('skills-edit', 'error', t('skillsSettings.editLoadFailed'))
        return
      }
      setEditRaw(result.raw)
    } catch (error) {
      if (editRequestRef.current !== requestId) return
      setEditingSkill(null)
      viewMessage(
        'skills-edit',
        'error',
        t('skillsSettings.editLoadFailedWithReason', { reason: String(error) })
      )
    } finally {
      if (editRequestRef.current === requestId) setEditLoading(false)
    }
  }

  const closeEdit = (): void => {
    editRequestRef.current += 1
    setEditingSkill(null)
    setEditRaw('')
    setEditLoading(false)
  }

  const handleSaveEdit = async (): Promise<void> => {
    if (!editingSkill || editLoading) return
    if (!editRaw.trim()) {
      viewMessage('skills-edit', 'warning', t('skillsSettings.emptyContent'))
      return
    }
    setSavingSkill(true)
    try {
      const saved = await harnessApi.harness.saveSkill(editingSkill.id, editRaw)
      if (!saved) {
        viewMessage('skills-edit', 'error', t('skillsSettings.saveFailed'))
        return
      }
      viewMessage('skills-edit', 'success', t('skillsSettings.savedSkill'), 2)
      closeEdit()
      setSkillsRefreshKey((k) => k + 1)
    } catch (error) {
      viewMessage(
        'skills-edit',
        'error',
        t('skillsSettings.saveFailedWithReason', { reason: String(error) })
      )
    } finally {
      setSavingSkill(false)
    }
  }

  const handleDelete = (skill: SkillInfo): void => {
    modal.confirm({
      title: t('skillsSettings.deleteConfirmTitle', { name: skill.name }),
      content: t('skillsSettings.deleteConfirmBody', { id: skill.id }),
      okText: t('common.action.confirm'),
      okType: 'danger',
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        try {
          const deleted = await harnessApi.harness.deleteSkill(skill.id)
          if (!deleted) {
            viewMessage('skills-delete', 'error', t('skillsSettings.deleteFailed'))
            return
          }
          viewMessage('skills-delete', 'success', t('skillsSettings.deleted'), 2)
          if (detail?.id === skill.id) closeDetail()
          if (editingSkill?.id === skill.id) closeEdit()
          setSkillsRefreshKey((k) => k + 1)
        } catch (error) {
          viewMessage(
            'skills-delete',
            'error',
            t('skillsSettings.deleteFailedWithReason', { reason: String(error) })
          )
        }
      }
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0
      }}
    >
      <SettingsPageHeader
        title={t('skillsSettings.pageTitle')}
        description={t('skillsSettings.pageDescription')}
      />

      {/* Directory selection (fixed at the top, does not scroll with the skill list) */}
      <SettingsSection
        style={{ flexShrink: 0 }}
        title={t('skillsSettings.dirSectionTitle')}
        icon={<FolderOutlined size={14} />}
        description={t('skillsSettings.dirSectionDescription')}
        bodyPadding={16}
      >
        <div style={{ display: 'flex', gap: 8, maxWidth: 560 }}>
          <Input
            value={skillsPathDraft}
            onChange={(e) => setSkillsPathDraft(e.target.value)}
            placeholder={t('skillsSettings.dirPlaceholder')}
            allowClear
            style={{ flex: 1 }}
          />
          <Button onClick={handleBrowsePath}>{t('common.action.browse')}…</Button>
          <Button
            type="primary"
            loading={savingPath}
            disabled={skillsPathDraft.trim() === savedSkillsPath}
            onClick={handleSavePath}
          >
            {t('common.action.save')}
          </Button>
        </div>
        {savedSkillsPath && (
          <p
            style={{
              margin: '10px 0 0',
              fontSize: 12,
              opacity: 0.65,
              wordBreak: 'break-all'
            }}
          >
            {t('skillsSettings.dirCurrent', { path: savedSkillsPath })}
          </p>
        )}
      </SettingsSection>

      {/* Skill list: takes the remaining height, the card grid scrolls by itself */}
      {savedSkillsPath ? (
        <SettingsSection
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            marginBottom: 0
          }}
          title={t('skillsSettings.listTitle', { count: skills.length })}
          extra={
            <Input
              size="small"
              allowClear
              value={skillQuery}
              onChange={(event) => setSkillQuery(event.target.value)}
              prefix={<SearchOutlined style={{ color: colorTextTertiary }} />}
              placeholder={t('skillsSettings.searchPlaceholder')}
              aria-label={t('skillsSettings.searchPlaceholder')}
              style={{ width: 220 }}
            />
          }
          bodyStyle={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}
          bodyClassName="custom-scrollbar"
        >
          {loadingSkills ? (
            <SkeletonSettingRows rows={5} />
          ) : skillsLoadFailed ? (
            <div
              style={{
                padding: '32px 0',
                textAlign: 'center',
                fontSize: 13,
                color: colorTextTertiary
              }}
            >
              {t('skillsSettings.listLoadFailed')}
            </div>
          ) : filteredSkills.length > 0 ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
                gap: 14
              }}
            >
              {filteredSkills.map((skill) => (
                <EntityCard
                  key={skill.id}
                  id={skill.id}
                  dataAttrs={{ 'data-skill-id': skill.id }}
                  icon={<FileTextOutlined />}
                  title={skill.name}
                  description={skill.description || undefined}
                  onClick={() => void handleOpenDetail(skill)}
                  footerEnd={
                    <div
                      // Edit / delete handle their own clicks; do not also trigger
                      // "open card detail"
                      onClick={(event) => event.stopPropagation()}
                      className="flex items-center"
                      style={{ gap: 2, marginLeft: 'auto' }}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        aria-label={t('skillsSettings.edit')}
                        title={t('skillsSettings.edit')}
                        onClick={() => void handleOpenEdit(skill)}
                      />
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={t('skillsSettings.delete')}
                        title={t('skillsSettings.delete')}
                        onClick={() => handleDelete(skill)}
                      />
                    </div>
                  }
                />
              ))}
            </div>
          ) : skills.length > 0 ? (
            <div
              style={{
                padding: '32px 0',
                textAlign: 'center',
                fontSize: 13,
                color: colorTextTertiary
              }}
            >
              {t('skillsSettings.searchNoMatch')}
            </div>
          ) : (
            <div
              style={{
                padding: '32px 0',
                textAlign: 'center',
                fontSize: 13,
                color: colorTextTertiary
              }}
            >
              {t('skillsSettings.emptyDescription', { filename: 'SKILL.md' })}
            </div>
          )}
        </SettingsSection>
      ) : null}

      {/* Skill content: reuses the library's Markdown preview modal (same full-window layout
          and scroll container) */}
      <MarkdownPreviewModal
        open={detail !== null}
        onCancel={closeDetail}
        title={detail?.name || t('skillsSettings.detailTitle')}
        content={detail?.content}
        emptyText={t('skillsSettings.detailEmpty')}
        loading={detailLoading}
      />

      {/* Edit raw SKILL.md (including frontmatter) */}
      <Modal
        open={editingSkill !== null}
        title={t('skillsSettings.editTitle', {
          name: editingSkill?.name ?? editingSkill?.id ?? ''
        })}
        onCancel={() => {
          if (!savingSkill) closeEdit()
        }}
        onOk={() => void handleSaveEdit()}
        confirmLoading={savingSkill}
        okButtonProps={{ disabled: editLoading }}
        cancelButtonProps={{ disabled: savingSkill }}
        okText={t('common.action.save')}
        cancelText={t('common.action.cancel')}
        width={820}
        destroyOnHidden
      >
        {editLoading ? (
          <div style={{ padding: '48px 0', textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <>
            <p
              style={{
                margin: '0 0 10px',
                fontSize: 12,
                lineHeight: 1.6,
                color: colorTextTertiary
              }}
            >
              {t('skillsSettings.editHint')}
            </p>
            <Input.TextArea
              value={editRaw}
              onChange={(event) => setEditRaw(event.target.value)}
              rows={18}
              spellCheck={false}
              placeholder={t('skillsSettings.editPlaceholder')}
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 12.5,
                lineHeight: 1.6
              }}
            />
          </>
        )}
      </Modal>
    </div>
  )
}

export default SkillsSettings
