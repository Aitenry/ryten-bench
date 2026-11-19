import React, { useState, useEffect, useCallback } from 'react'
import { theme, Button, Input, Switch, Pagination } from 'antd'
import { FolderOutlined } from '@ant-design/icons'
import { SkeletonSettingRows } from '@renderer/components/system/Skeleton'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import type { SystemSettings, HarnessSettings } from '@renderer/types/settings'
import {
  SettingsPageHeader,
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi } from '../../api'

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

  // 目录有效时加载技能列表
  useEffect(() => {
    if (!skillsPath) {
      setSkills([])
      return
    }
    setLoadingSkills(true)
    setCurrentPage(1)
    harnessApi.harness
      .listSkills()
      .then((list: SkillInfo[]) => setSkills(list))
      .catch(() => setSkills([]))
      .finally(() => setLoadingSkills(false))
  }, [skillsPath, skillsRefreshKey])

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
      const current = settings?.harness
      if (!current) return

      let next: string[] | undefined
      if (checked) {
        // 启用：从 disabled 列表移除（如果没有 disabled 列表，说明全部启用，不操作）
        if (enabledSkills) {
          next = [...enabledSkills, skillId]
        }
        // enabledSkills 为 undefined 表示全部启用，无需操作
      } else {
        // 禁用：加入 disabled 列表
        if (enabledSkills) {
          next = enabledSkills.filter((s) => s !== skillId)
        } else {
          // 当前全部启用，需要生成完整列表（排除当前skill）
          next = skills.filter((s) => s.id !== skillId).map((s) => s.id)
        }
      }

      const nextHarness: HarnessSettings = { ...current, enabledSkills: next }
      await window.api.systemSettings.update({ harness: nextHarness })
      setSettings((prev) => (prev ? { ...prev, harness: nextHarness } : prev))
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('common.message.operationFailedWithReason', { reason: String(error) })
      )
    }
  }

  // 分页
  const paginatedSkills = skills.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

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
        /* 技能行与 SettingRow 同构：左标题 + 描述，右开关 */
        <div style={{ padding: '4px 0' }}>
          <SkeletonSettingRows rows={5} />
        </div>
      ) : skills.length > 0 ? (
        <SettingsSection title={t('skillsSettings.listTitle', { count: skills.length })}>
          {paginatedSkills.map((skill) => {
            const isEnabled = !enabledSkills || enabledSkills.includes(skill.id)
            return (
              <SettingRow
                key={skill.id}
                title={skill.name}
                description={skill.description || undefined}
                control={
                  <Switch
                    checked={isEnabled}
                    onChange={(checked) => handleToggleSkill(skill.id, checked)}
                    size="small"
                  />
                }
              />
            )
          })}
          {skills.length > PAGE_SIZE && (
            <div className="flex justify-center" style={{ padding: '10px 0' }}>
              <Pagination
                current={currentPage}
                total={skills.length}
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
