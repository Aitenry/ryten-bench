import React, { useState, useEffect, useCallback } from 'react'
import { InputNumber, Switch, Select } from 'antd'
import { useMessage } from '@renderer/hooks/useMessage'
import type { SystemSettings, GraphSettings as GraphSettingsType } from '@renderer/types/settings'
import type { ProviderOption } from '@renderer/types/components'
import { isEmbeddingProvider, getProviderDisplayName } from '@renderer/utils/providerMeta'
import { useTranslation } from '@renderer/i18n'
import {
  SettingsPageHeader,
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'

const GraphSettings: React.FC = () => {
  const { viewMessage } = useMessage()
  const { t } = useTranslation()

  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [embeddingProviders, setEmbeddingProviders] = useState<ProviderOption[]>([])

  const loadSettings = useCallback(async () => {
    const msgKey = 'graph-settings-load'
    try {
      const [result, providerList] = await Promise.all([
        window.api.systemSettings.getAll(),
        window.api.providers.getEnabled()
      ])
      setSettings(result)
      const allProviders = providerList as ProviderOption[]
      setProviders(allProviders.filter((p) => !isEmbeddingProvider(p)))
      setEmbeddingProviders(allProviders.filter((p) => isEmbeddingProvider(p)))
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

  const updateSettings = async (updates: Partial<SystemSettings>): Promise<void> => {
    const msgKey = 'graph-settings-save'
    try {
      viewMessage(msgKey, 'loading', t('common.action.saving'))
      await window.api.systemSettings.update(updates)
      viewMessage(msgKey, 'success', t('common.action.saveSuccess'), 2)
      await loadSettings()
    } catch (error) {
      viewMessage(
        msgKey,
        'error',
        t('common.message.saveFailedWithReason', { reason: String(error) })
      )
    }
  }

  const handleGraphChange = (field: keyof GraphSettingsType, value: unknown): void => {
    if (!settings) return
    updateSettings({ graph: { ...settings.graph, [field]: value } }).then()
  }

  const handleDefaultModelChange = (value: number): void => {
    updateSettings({ defaultModelId: value }).then()
  }

  const handleEmbeddingModelChange = (value: number): void => {
    updateSettings({ defaultEmbeddingModelId: value }).then()
  }

  return (
    <div>
      <SettingsPageHeader
        title={t('graphSettings.pageTitle')}
        description={t('graphSettings.pageDescription')}
      />

      {/* 图谱构建参数 */}
      <SettingsSection title={t('graphSettings.build.sectionTitle')} bodyPadding={0}>
        <SettingRow
          title={t('graphSettings.build.maxConcurrencyTitle')}
          description={t('graphSettings.build.maxConcurrencyDescription')}
          control={
            <InputNumber
              min={1}
              max={32}
              value={settings?.graph.maxConcurrency}
              onChange={(v) => v !== null && handleGraphChange('maxConcurrency', v)}
              style={{ width: 120 }}
            />
          }
        />
        <SettingRow
          title={t('graphSettings.build.gleaningTitle')}
          description={t('graphSettings.build.gleaningDescription')}
          control={
            <Switch
              checked={settings?.graph.enableGleaning}
              onChange={(v) => handleGraphChange('enableGleaning', v)}
            />
          }
        />
        <SettingRow
          title={t('graphSettings.build.gleaningThresholdTitle')}
          description={t('graphSettings.build.gleaningThresholdDescription')}
          control={
            <InputNumber
              min={0}
              max={500}
              value={settings?.graph.gleaningThreshold}
              onChange={(v) => v !== null && handleGraphChange('gleaningThreshold', v)}
              style={{ width: 120 }}
              disabled={!settings?.graph.enableGleaning}
            />
          }
        />
        <SettingRow
          title={t('graphSettings.build.chunkSizeTitle')}
          description={t('graphSettings.build.chunkSizeDescription')}
          control={
            <InputNumber
              min={500}
              max={10000}
              step={100}
              value={settings?.graph.maxChunkSize}
              onChange={(v) => v !== null && handleGraphChange('maxChunkSize', v)}
              style={{ width: 140 }}
            />
          }
        />
      </SettingsSection>

      {/* 默认模型 */}
      <SettingsSection title={t('graphSettings.model.sectionTitle')}>
        <SettingRow
          title={t('graphSettings.model.graphModelTitle')}
          description={t('graphSettings.model.graphModelDescription')}
          control={
            <Select
              placeholder={t('graphSettings.model.graphModelPlaceholder')}
              value={settings?.defaultModelId}
              onChange={handleDefaultModelChange}
              allowClear
              options={providers.map((p) => ({
                value: p.id,
                label: `${p.provider.toUpperCase()}: ${getProviderDisplayName(p)}`
              }))}
              style={{ width: 260 }}
            />
          }
        />
        <SettingRow
          title={t('graphSettings.model.embeddingTitle')}
          description={t('graphSettings.model.embeddingDescription')}
          control={
            <Select
              placeholder={t('graphSettings.model.embeddingPlaceholder')}
              value={settings?.defaultEmbeddingModelId}
              onChange={handleEmbeddingModelChange}
              allowClear
              options={embeddingProviders.map((p) => ({
                value: p.id,
                label: `${p.provider.toUpperCase()}: ${p.model}`
              }))}
              notFoundContent={
                <span style={{ color: 'inherit', opacity: 0.6 }}>
                  {t('graphSettings.model.embeddingEmpty')}
                </span>
              }
              style={{ width: 260 }}
            />
          }
        />
      </SettingsSection>
    </div>
  )
}

export default GraphSettings
