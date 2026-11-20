import React, { useState, useEffect, useCallback } from 'react'
import { theme, Button, Input, Switch, Pagination } from 'antd'
import { FolderOutlined, FileTextOutlined } from '@ant-design/icons'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import EntityCard from '@renderer/components/system/EntityCard'
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

const SkillsSettings: React.FC = () => {
  const {
    token: { colorTextTertiary }
  } = theme.useToken()

  const { viewMessage } = useMessage()
  const { t } = useTranslation()

  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [skillsPath, setSkillsPath] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsTotal, setSkillsTotal] = useState(0)
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [savingPath, setSavingPath] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0)
  const PAGE_SIZE = 5

  const enabledSkills = settings?.harness?.enabledSkills

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

  // 换目录 / 手动刷新：回到第一页
  useEffect(() => {
    setCurrentPage(1)
  }, [skillsPath, skillsRefreshKey])

  // 目录有效时加载当前页：分页在主进程完成，前端不再「全量拉取 + slice」
  useEffect(() => {
    if (!skillsPath) {
      setSkills([])
      setSkillsTotal(0)
      return
    }
    let cancelled = false
    setLoadingSkills(true)
    harnessApi.harness
      .listSkillsPaginated(currentPage - 1, PAGE_SIZE)
      .then((result) => {
        if (cancelled) return
        setSkills(result.items)
        setSkillsTotal(result.total)
      })
      .catch(() => {
        if (cancelled) return
        setSkills([])
        setSkillsTotal(0)
      })
      .finally(() => {
        if (!cancelled) setLoadingSkills(false)
      })
    return () => {
      cancelled = true
    }
  }, [skillsPath, skillsRefreshKey, currentPage])

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

  const handleToggleSkill = async (skillId: string, checked: boolean): Promise<void> => {
    const msgKey = `skill-toggle-${skillId}`
    try {
      // 启用清单的完整判定在主进程（需要完整技能目录）：这里只发「哪个技能、开还是关」
      const next = await harnessApi.harness.setSkillEnabled(skillId, checked)
      setSettings((prev) =>
        prev ? { ...prev, harness: { ...(prev.harness ?? {}), enabledSkills: next } } : prev
      )
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('common.message.operationFailedWithReason', { reason: String(error) })
      )
    }
  }

  return (
    <div>
      <SettingsPageHeader
        title={t('skillsSettings.pageTitle')}
        description={t('skillsSettings.pageDescription')}
      />

      {/* 目录选择 */}
      <SettingsSection
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

      {/* 技能列表 */}
      {loadingSkills ? (
        /* 技能卡片网格：加载时用与卡片同高的骨架行 */
        <div style={{ padding: '4px 0' }}>
          <SkeletonSettingRows rows={5} />
        </div>
      ) : skillsTotal > 0 ? (
        <SettingsSection title={t('skillsSettings.listTitle', { count: skillsTotal })}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',
              gap: 14,
              padding: 16
            }}
          >
            {skills.map((skill) => {
              const isEnabled = !enabledSkills || enabledSkills.includes(skill.id)
              return (
                <EntityCard
                  key={skill.id}
                  id={skill.id}
                  icon={<FileTextOutlined />}
                  title={skill.name}
                  description={skill.description || undefined}
                  footerEnd={
                    <span style={{ marginLeft: 'auto' }}>
                      <Switch
                        checked={isEnabled}
                        onChange={(checked) => handleToggleSkill(skill.id, checked)}
                        size="small"
                      />
                    </span>
                  }
                />
              )
            })}
          </div>
          {skillsTotal > PAGE_SIZE && (
            <div className="flex justify-center" style={{ padding: '10px 0' }}>
              <Pagination
                current={currentPage}
                total={skillsTotal}
                pageSize={PAGE_SIZE}
                onChange={(page) => setCurrentPage(page)}
                size="small"
              />
            </div>
          )}
        </SettingsSection>
      ) : settings?.harness?.skillsPath ? (
        <div
          style={{ padding: '32px 0', textAlign: 'center', fontSize: 13, color: colorTextTertiary }}
        >
          {t('skillsSettings.emptyDescription', { filename: 'SKILL.md' })}
        </div>
      ) : null}
    </div>
  )
}

export default SkillsSettings
