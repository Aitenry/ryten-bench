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
 * 改密码弹窗里 6 位数字格子的公共属性。
 *
 * - `type="password"`：格子内容必须隐藏。antd 6.5.1 的 `mask` 布尔值有 bug（会把原始
 *   数字画在格子上层，6.5.3 才修复），这里用原生密码输入框，与锁屏界面同一口径；
 * - `otp-fill`：6 个格子均分弹窗宽度（antd 默认每格约 50px，只占左半边，见 assets/main.css）。
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
  /** 锁屏开关 / 自动锁屏时长 / 是否仍是默认码：主进程快照（摘要不在渲染层） */
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
   * 启用 / 关闭锁屏：走锁屏专用通道（渲染层不能直接写 `lock` 设置，见 ipc/settings.ts），
   * 主进程落盘并广播新快照 —— Esc 判定与设置页开关读的是同一份状态，不必重启。
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
   * 改码：原密码的校验在主进程（旧实现拿渲染层里的 MD5 比对，等于把摘要公开给界面代码），
   * 这里只负责收集输入并把失败原因显示在弹窗里。
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

  /** 自动锁屏下拉：与主进程 `AUTO_LOCK_MINUTES_OPTIONS` 一一对应（0 = 关闭） */
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

  /** 语言下拉只有两项；语言名用各自母语书写，两种界面下都自解释 */
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

      {/* 界面语言 */}
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

      {/* 主题设置 */}
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

      {/* 系统托盘设置 */}
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

      {/* 锁屏设置 */}
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

      {/* 修改密码弹窗 */}
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
