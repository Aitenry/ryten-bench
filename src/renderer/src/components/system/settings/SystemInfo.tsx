import React, { useState, useEffect, useCallback } from 'react'
import { theme } from 'antd'
import { useMessage } from '@renderer/hooks/useMessage'
import type { SystemSettings } from '@renderer/types/settings'
import { useTranslation } from '@renderer/i18n'
import { SettingsPageHeader, SettingsSection, SettingRow } from './SettingsUI'

const SystemInfo: React.FC = () => {
  const {
    token: { colorTextTertiary }
  } = theme.useToken()

  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const [settings, setSettings] = useState<SystemSettings | null>(null)

  const loadSettings = useCallback(async () => {
    const msgKey = 'system-info-load'
    try {
      const result = await window.api.systemSettings.getAll()
      setSettings(result)
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

  const ipValue = (value: string | undefined): React.ReactNode =>
    value ? (
      <span>{value}</span>
    ) : (
      <span style={{ color: colorTextTertiary }}>{t('systemInfo.unavailable')}</span>
    )

  return (
    <div>
      <SettingsPageHeader
        title={t('systemInfo.pageTitle')}
        description={t('systemInfo.pageDescription')}
      />

      <SettingsSection title={t('systemInfo.sectionTitle')}>
        <SettingRow
          title={t('systemInfo.ipTitle')}
          control={ipValue(settings?.ip?.query as string | undefined)}
        />
        <SettingRow
          title={t('systemInfo.locationTitle')}
          control={
            settings?.ip?.city ? (
              `${settings.ip.country as string} ${settings.ip.regionName as string} ${settings.ip.city as string}`
            ) : (
              <span style={{ color: colorTextTertiary }}>{t('systemInfo.unavailable')}</span>
            )
          }
        />
        <SettingRow
          title={t('systemInfo.ispTitle')}
          control={ipValue(settings?.ip?.isp as string | undefined)}
        />
        <SettingRow
          title={t('systemInfo.encryptionTitle')}
          control={<span style={{ color: '#52c41a' }}>{t('systemInfo.encryptionValue')}</span>}
        />
      </SettingsSection>
    </div>
  )
}

export default SystemInfo
