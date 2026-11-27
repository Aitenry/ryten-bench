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
 * 技能页：目录配置 + 技能卡片。
 *
 * 用户 2026-11-27 口径：
 * - 技能是否启用仍在对话输入框下面逐会话选择；技能页**不做启用开关**；
 * - 技能页只负责管理：点卡片看 SKILL.md 正文，卡片右下角「编辑 / 删除」；
 * - 列表不再分页：技能多时让卡片网格自己滚动，页面标题/目录区固定在顶部。
 */
const SkillsSettings: React.FC = () => {
  const {
    token: { colorTextTertiary }
  } = theme.useToken()

  const { viewMessage } = useMessage()
  const { modal } = App.useApp()
  const { t } = useTranslation()

  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [skillsPath, setSkillsPath] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  /** 「已发现的技能」标题右侧的搜索词：只过滤当前列表，不改目录/启用状态 */
  const [skillQuery, setSkillQuery] = useState('')
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [savingPath, setSavingPath] = useState(false)
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0)

  /** 查看正文：先放元信息开弹窗，正文回来再填（读盘很快，但保持有反馈） */
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const detailRequestRef = useRef(0)

  /** 编辑：SKILL.md 原文（含 frontmatter） */
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
      setSkillsPath(result.harness?.skillsPath ?? '')
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

  // 目录有效时加载全部技能：技能数量是「本地目录里的子目录数」，一页 5 个会让宽屏
  // 只剩一行、下面大片空白，也看不到后面的技能；直接全量（主进程只读 frontmatter）。
  useEffect(() => {
    if (!skillsPath) {
      setSkills([])
      setLoadingSkills(false)
      return
    }
    let cancelled = false
    setLoadingSkills(true)
    harnessApi.harness
      .listSkills()
      .then((result) => {
        if (!cancelled) setSkills(result)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
      .finally(() => {
        if (!cancelled) setLoadingSkills(false)
      })
    return () => {
      cancelled = true
    }
  }, [skillsPath, skillsRefreshKey])

  // 换目录后上一份搜索词没有意义，清掉，避免新目录一进来就是空列表
  useEffect(() => {
    setSkillQuery('')
  }, [skillsPath])

  /** 搜索：名称 / 目录 id / 描述都认（与输入框面板的搜索口径一致） */
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
      if (path) setSkillsPath(path)
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
      const trimmed = skillsPath.trim()
      const nextHarness: HarnessSettings = {
        ...(settings?.harness ?? {}),
        skillsPath: trimmed || undefined
      }
      await window.api.systemSettings.update({ harness: nextHarness })
      setSettings((prev) => (prev ? { ...prev, harness: nextHarness } : prev))
      setSkillsPath(trimmed)
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

  /** 打开正文：先显示弹窗骨架，读到后替换；关掉或换技能会作废旧请求 */
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

  /** 打开编辑：拉 SKILL.md 原文（含 frontmatter），保存时原样写回 */
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
      content: t('skillsSettings.deleteConfirmBody'),
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

      {/* 目录选择（固定在顶部，不随技能列表滚动） */}
      <SettingsSection
        style={{ flexShrink: 0 }}
        title={t('skillsSettings.dirSectionTitle')}
        icon={<FolderOutlined size={14} />}
        description={t('skillsSettings.dirSectionDescription')}
        bodyPadding={16}
      >
        <div style={{ display: 'flex', gap: 8, maxWidth: 560 }}>
          <Input
            value={skillsPath}
            onChange={(e) => setSkillsPath(e.target.value)}
            placeholder={t('skillsSettings.dirPlaceholder')}
            allowClear
            style={{ flex: 1 }}
          />
          <Button onClick={handleBrowsePath}>{t('common.action.browse')}…</Button>
          <Button
            type="primary"
            loading={savingPath}
            disabled={skillsPath.trim() === (settings?.harness?.skillsPath ?? '')}
            onClick={handleSavePath}
          >
            {t('common.action.save')}
          </Button>
        </div>
        {settings?.harness?.skillsPath && (
          <p
            style={{
              margin: '10px 0 0',
              fontSize: 12,
              opacity: 0.65,
              wordBreak: 'break-all'
            }}
          >
            {t('skillsSettings.dirCurrent', { path: settings.harness.skillsPath })}
          </p>
        )}
      </SettingsSection>

      {/* 技能列表：吃掉剩余高度，卡片网格自己滚动 */}
      {skillsPath ? (
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
                      // 编辑 / 删除自己处理点击，不要把「开卡片详情」一起触发
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

      {/* 技能正文：复用资料库的 Markdown 预览弹窗（同一套整窗宽布局与滚动容器） */}
      <MarkdownPreviewModal
        open={detail !== null}
        onCancel={closeDetail}
        title={detail?.name || t('skillsSettings.detailTitle')}
        content={detail?.content}
        emptyText={t('skillsSettings.detailEmpty')}
        loading={detailLoading}
      />

      {/* 编辑 SKILL.md 原文（含 frontmatter） */}
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
