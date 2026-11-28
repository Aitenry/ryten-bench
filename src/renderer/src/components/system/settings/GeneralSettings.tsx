import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Switch, Button, Segmented, Select, Modal, Form, Input, Alert, theme } from 'antd'
import {
  LockOutlined,
  BgColorsOutlined,
  NotificationOutlined,
  TranslationOutlined,
  ExclamationCircleOutlined
} from '@ant-design/icons'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTheme } from '@renderer/hooks/useTheme'
import { useLanguage } from '@renderer/hooks/useLanguage'
import { useTranslation } from '@renderer/i18n'
import type { SystemSettings, ThemeMode, AppLanguage } from '@renderer/types/settings'
import { SettingsPageHeader, SettingsSection, SettingRow } from './SettingsUI'
import {
  changeLockCode,
  configureLock,
  installLockScreenBridge,
  useLockScreenState
} from '../lock-screen-state'

/**
 * Shared props for the six passcode cells in the change-password modal.
 *
 * - `type="password"`: the cell contents must be hidden. The `mask` boolean in antd 6.5.1 is buggy
 *   (it paints the raw digits on top of the cells; fixed in 6.5.3), so use a native password input,
 *   consistent with the lock screen;
 * - `otp-fill`: the six cells share the modal width evenly (antd defaults to ~50px per cell, which
 *   only covers the left half, see assets/main.css).
 */
const PASSCODE_OTP_PROPS = {
  length: 6,
  className: 'otp-fill settings-password-otp',
  formatter: (value: string) => value.replace(/\D/g, ''),
  type: 'password',
  inputMode: 'numeric',
  autoComplete: 'off'
} satisfies React.ComponentProps<typeof Input.OTP>

const GeneralSettings: React.FC = () => {
  const { t } = useTranslation()
  const { viewMessage } = useMessage()
  const { themeMode, setThemeMode } = useTheme()
  const { language, setLanguage } = useLanguage()
  const { token } = theme.useToken()

  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordForm] = Form.useForm()
  /** Lock screen switch / auto-lock delay / whether the default code is still in use: main-process snapshot (the digest never reaches the renderer) */
  const lockState = useLockScreenState()

  useEffect(() => installLockScreenBridge(), [])

  const loadSettings = useCallback(async () => {
    const msgKey = 'general-settings-load'
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

  const updateSettings = async (updates: Partial<SystemSettings>): Promise<void> => {
    const msgKey = 'general-settings-save'
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

  const handleThemeChange = (value: string | number): void => {
    setThemeMode(value as ThemeMode).then()
  }

  const handleLanguageChange = (value: AppLanguage): void => {
    setLanguage(value).then()
  }

  /**
   * Enable / disable the lock screen: goes through the lock-specific channel (the renderer cannot
   * write the `lock` settings directly, see ipc/settings.ts); the main process persists it and
   * broadcasts the new snapshot — the Esc check and this settings switch read the same state, so no
   * restart is needed.
   */
  const handleLockViewChange = async (checked: boolean): Promise<void> => {
    try {
      await configureLock({ enabled: checked })
    } catch (error) {
      viewMessage(
        'lock-view-save',
        'error',
        t('common.message.saveFailedWithReason', { reason: String(error) })
      )
    }
  }

  const handleAutoLockChange = async (minutes: number): Promise<void> => {
    try {
      await configureLock({ autoLockMinutes: minutes })
    } catch (error) {
      viewMessage(
        'lock-autolock-save',
        'error',
        t('common.message.saveFailedWithReason', { reason: String(error) })
      )
    }
  }

  /**
   * Change code: the old password is verified in the main process (the previous implementation
   * compared an MD5 held in the renderer, exposing the digest to UI code); here we only collect the
   * input and show the failure reason in the modal.
   */
  const handleChangePassword = async (): Promise<void> => {
    try {
      const values = await passwordForm.validateFields()
      const result = await changeLockCode(values.oldPassword ?? '', values.newPassword)
      if (!result.ok) {
        if (result.reason === 'wrong-old') {
          setPasswordError(t('settings.general.passwordModal.wrongOldPassword'))
        } else if (result.reason === 'invalid-new') {
          setPasswordError(t('settings.general.passwordModal.sixDigits'))
        } else {
          setPasswordError(t('settings.general.passwordModal.changeFailed'))
        }
        return
      }
      setPasswordModalOpen(false)
      setPasswordError(null)
      passwordForm.resetFields()
      viewMessage('password-saved', 'success', t('settings.general.passwordModal.changeSuccess'), 2)
    } catch (error) {
      if (error && typeof error === 'object' && 'errorFields' in error) return
      viewMessage(
        'password-error',
        'error',
        t('common.message.operationFailedWithReason', { reason: String(error) })
      )
    }
  }

  /** Auto-lock dropdown: maps one-to-one to `AUTO_LOCK_MINUTES_OPTIONS` in the main process (0 = off) */
  const autoLockOptions = useMemo(
    () => [
      { value: 0, label: t('settings.general.lock.autoLockOff') },
      { value: 1, label: t('settings.general.lock.autoLockMinutes', { minutes: 1 }) },
      { value: 5, label: t('settings.general.lock.autoLockMinutes', { minutes: 5 }) },
      { value: 15, label: t('settings.general.lock.autoLockMinutes', { minutes: 15 }) },
      { value: 30, label: t('settings.general.lock.autoLockMinutes', { minutes: 30 }) }
    ],
    [t]
  )

  /** The language dropdown has only two entries; each language name is written in its own language, so it explains itself in either UI */
  const languageOptions = useMemo(
    () => [
      { value: 'zh-CN' as AppLanguage, label: t('common.language.zhCN') },
      { value: 'en-US' as AppLanguage, label: t('common.language.enUS') }
    ],
    [t]
  )

  return (
    <div>
      <SettingsPageHeader
        title={t('settings.general.pageTitle')}
        description={t('settings.general.pageDescription')}
      />

      {/* UI language */}
      <SettingsSection
        title={t('settings.general.language.sectionTitle')}
        icon={<TranslationOutlined size={14} />}
        description={t('settings.general.language.sectionDescription')}
      >
        <SettingRow
          title={t('settings.general.language.rowTitle')}
          description={t('settings.general.language.rowDescription')}
          control={
            <Select
              value={language}
              onChange={handleLanguageChange}
              options={languageOptions}
              style={{ width: 160 }}
            />
          }
        />
      </SettingsSection>

      {/* Theme settings */}
      <SettingsSection
        title={t('settings.general.theme.sectionTitle')}
        icon={<BgColorsOutlined size={14} />}
        description={t('settings.general.theme.sectionDescription')}
      >
        <SettingRow
          title={t('settings.general.theme.rowTitle')}
          description={t('settings.general.theme.rowDescription')}
          control={
            <Segmented
              value={themeMode}
              onChange={handleThemeChange}
              options={[
                { label: t('settings.general.theme.light'), value: 'light' },
                { label: t('settings.general.theme.dark'), value: 'dark' },
                { label: t('settings.general.theme.auto'), value: 'auto' }
              ]}
            />
          }
        />
      </SettingsSection>

      {/* System tray settings */}
      <SettingsSection
        title={t('settings.general.tray.sectionTitle')}
        icon={<NotificationOutlined size={14} />}
        description={t('settings.general.tray.sectionDescription')}
      >
        <SettingRow
          title={t('settings.general.tray.rowTitle')}
          description={t('settings.general.tray.rowDescription')}
          control={
            <Switch
              checked={settings?.tray?.closeToTray ?? true}
              onChange={(checked) => updateSettings({ tray: { closeToTray: checked } })}
            />
          }
        />
      </SettingsSection>

      {/* Lock screen settings */}
      <SettingsSection
        title={t('settings.general.lock.sectionTitle')}
        icon={<LockOutlined size={14} />}
        description={t('settings.general.lock.sectionDescription')}
      >
        <SettingRow
          title={t('settings.general.lock.enableTitle')}
          description={t('settings.general.lock.enableDescription')}
          control={
            <Switch
              checked={lockState.enabled}
              onChange={(checked) => void handleLockViewChange(checked)}
            />
          }
        />
        {lockState.enabled && lockState.usingDefaultCode && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '11px 18px',
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              color: token.colorWarning,
              fontSize: 12,
              lineHeight: '18px'
            }}
          >
            <ExclamationCircleOutlined style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{t('settings.general.lock.defaultCodeWarning')}</span>
          </div>
        )}
        <SettingRow
          title={t('settings.general.lock.autoLockTitle')}
          description={t('settings.general.lock.autoLockDescription')}
          control={
            <Select
              value={lockState.autoLockMinutes}
              onChange={(value: number) => void handleAutoLockChange(value)}
              options={autoLockOptions}
              disabled={!lockState.enabled}
              style={{ width: 150 }}
            />
          }
        />
        <SettingRow
          title={t('settings.general.lock.passwordTitle')}
          description={t('settings.general.lock.passwordDescription')}
          control={
            <Button
              size="small"
              onClick={() => {
                setPasswordError(null)
                setPasswordModalOpen(true)
              }}
            >
              {t('settings.general.lock.changePassword')}
            </Button>
          }
        />
      </SettingsSection>

      {/* Change-password modal */}
      <Modal
        title={
          lockState.hasCode
            ? t('settings.general.passwordModal.title')
            : t('settings.general.passwordModal.setTitle')
        }
        open={passwordModalOpen}
        destroyOnHidden
        onCancel={() => {
          setPasswordModalOpen(false)
          setPasswordError(null)
          passwordForm.resetFields()
        }}
        onOk={handleChangePassword}
        okText={t('common.action.confirm')}
        cancelText={t('common.action.cancel')}
      >
        {passwordError && (
          <Alert type="error" showIcon message={passwordError} style={{ marginBottom: 14 }} />
        )}
        <Form form={passwordForm} layout="vertical" className="mt-4">
          {lockState.hasCode && (
            <Form.Item
              name="oldPassword"
              label={t('settings.general.passwordModal.oldPassword')}
              rules={[
                {
                  required: true,
                  message: t('settings.general.passwordModal.oldPasswordRequired')
                },
                { pattern: /^\d{6}$/, message: t('settings.general.passwordModal.sixDigits') }
              ]}
            >
              <Input.OTP {...PASSCODE_OTP_PROPS} />
            </Form.Item>
          )}
          <Form.Item
            name="newPassword"
            label={t('settings.general.passwordModal.newPassword')}
            rules={[
              { required: true, message: t('settings.general.passwordModal.newPasswordRequired') },
              { pattern: /^\d{6}$/, message: t('settings.general.passwordModal.sixDigits') }
            ]}
          >
            <Input.OTP {...PASSCODE_OTP_PROPS} />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label={t('settings.general.passwordModal.confirmPassword')}
            dependencies={['newPassword']}
            rules={[
              {
                required: true,
                message: t('settings.general.passwordModal.confirmPasswordRequired')
              },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error(t('settings.general.passwordModal.mismatch')))
                }
              })
            ]}
          >
            <Input.OTP {...PASSCODE_OTP_PROPS} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default GeneralSettings
