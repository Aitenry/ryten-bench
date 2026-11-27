/**
 * 设置 →「联网搜索」页。
 *
 * 版式对齐设计稿：
 * - 三个搜索服务单选项（内置搜索 / DeepSeek / Tavily），各带品牌图标、状态 pill、
 *   密钥掩码（前 6 + 后 6）与「测试 / 配置」；
 * - 行为开关：失败回退、请求正文摘要；
 * - 配置弹窗只填密钥（不显示请求地址、无底部提示），保存前先测试；
 * - 密钥只保存在本机并加密；「模型」里已有同厂商 Key 时给复用提示。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Input, Modal, Radio, Spin, Tag, theme } from 'antd'
import { RiGlobalLine } from '@remixicon/react'
import deepseekIcon from '@renderer/assets/brands/deepseek.png'
import tavilyIcon from '@renderer/assets/brands/tavily.png'
import { useTranslation } from '@renderer/i18n'
import {
  SettingsPageHeader,
  SettingsSection,
  SettingRow
} from '@renderer/components/system/settings/SettingsUI'
import { harnessApi, type SearchProviderId, type SearchSettingsView } from '../../../api/harness'

/** 可配置密钥的服务（内置搜索不需要） */
type KeyedProvider = Exclude<SearchProviderId, 'builtin'>

const PROVIDER_ICONS: Record<SearchProviderId, React.ReactNode> = {
  builtin: <RiGlobalLine size={18} />,
  deepseek: <img src={deepseekIcon} alt="DeepSeek" style={{ width: 18, height: 18 }} />,
  tavily: <img src={tavilyIcon} alt="Tavily" style={{ width: 18, height: 18 }} />
}

/** 各服务的帮助链接（「去获取」） */
const PROVIDER_KEY_URLS: Record<KeyedProvider, string> = {
  deepseek: 'https://platform.deepseek.com',
  tavily: 'https://app.tavily.com'
}

const SearchSettings: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [view, setView] = useState<SearchSettingsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState<SearchProviderId | null>(null)
  const [configProvider, setConfigProvider] = useState<KeyedProvider | null>(null)
  const [configKey, setConfigKey] = useState('')
  const [saving, setSaving] = useState(false)
  const { message: messageApi, modal: modalApi } = App.useApp()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setView(await harnessApi.harness.getSearchSettings())
    } catch (error) {
      messageApi.error(t('searchSettings.loadFailed', { reason: String(error) }))
      setView(null)
    } finally {
      setLoading(false)
    }
  }, [messageApi, t])

  useEffect(() => {
    void load()
  }, [load])

  const providerName = useCallback(
    (provider: SearchProviderId): string => {
      if (provider === 'builtin') return t('searchSettings.builtinName')
      if (provider === 'deepseek') return t('searchSettings.deepseekName')
      return t('searchSettings.tavilyName')
    },
    [t]
  )

  const providerDesc = useCallback(
    (provider: SearchProviderId): string => {
      if (provider === 'builtin') return t('searchSettings.builtinDesc')
      if (provider === 'deepseek') return t('searchSettings.deepseekDesc')
      return t('searchSettings.tavilyDesc')
    },
    [t]
  )

  const errorLabel = useCallback(
    (code: string | undefined): string => {
      if (!code) return t('searchSettings.saveFailed')
      const labels = t('searchSettings.errorLabels', { returnObjects: true }) as Record<
        string,
        string
      >
      return labels?.[code] ?? code
    },
    [t]
  )

  const runTest = useCallback(
    async (provider: SearchProviderId): Promise<boolean> => {
      setTesting(provider)
      try {
        const result = await harnessApi.harness.testSearchProvider(provider)
        if (result.ok) {
          messageApi.success(t('searchSettings.testSuccess', { ms: String(result.elapsedMs) }))
          return true
        }
        messageApi.error(
          t('searchSettings.testFailed', { reason: errorLabel(result.code) })
        )
        return false
      } catch (error) {
        messageApi.error(t('searchSettings.testFailed', { reason: String(error) }))
        return false
      } finally {
        setTesting(null)
      }
    },
    [errorLabel, messageApi, t]
  )

  const selectDefault = useCallback(
    async (provider: SearchProviderId): Promise<void> => {
      const state = view?.providers.find((item) => item.provider === provider)
      if (state?.requiresKey && !state.configured) {
        messageApi.info(t('searchSettings.notConfiguredHint'))
        if (provider !== 'builtin') {
          setConfigProvider(provider)
          setConfigKey('')
        }
        return
      }
      const result = await harnessApi.harness.setSearchDefault(provider).catch(() => null)
      if (!result?.ok) {
        messageApi.error(t('searchSettings.saveFailed'))
        return
      }
      messageApi.success(t('searchSettings.defaultChanged'))
      await load()
    },
    [load, messageApi, t, view]
  )

  const toggleBehavior = useCallback(
    async (patch: { autoFallback?: boolean; includeContent?: boolean }): Promise<void> => {
      const previous = view
      if (view) setView({ ...view, ...patch })
      const result = await harnessApi.harness.setSearchBehaviors(patch).catch(() => null)
      if (!result?.ok) {
        setView(previous)
        messageApi.error(t('searchSettings.saveFailed'))
      }
    },
    [messageApi, t, view]
  )

  const handleSaveKey = useCallback(async (): Promise<void> => {
    if (!configProvider) return
    const key = configKey.trim()
    if (!key) {
      messageApi.error(t('searchSettings.keyEmpty'))
      return
    }
    if (/\s/.test(key)) {
      messageApi.error(t('searchSettings.keyInvalid'))
      return
    }
    setSaving(true)
    try {
      const saved = await harnessApi.harness.saveSearchProviderKey(configProvider, key)
      if (!saved.ok) {
        messageApi.error(errorLabel(saved.error))
        return
      }
      // 保存后立即测试；失败则撤掉这份密钥，避免留下不可用的配置
      const passed = await runTest(configProvider)
      if (!passed) {
        await harnessApi.harness.clearSearchProviderKey(configProvider).catch(() => null)
        return
      }
      messageApi.success(t('searchSettings.saveSuccess'))
      await harnessApi.harness.setSearchDefault(configProvider).catch(() => null)
      setConfigProvider(null)
      setConfigKey('')
      await load()
    } catch (error) {
      messageApi.error(t('searchSettings.loadFailed', { reason: String(error) }))
    } finally {
      setSaving(false)
    }
  }, [configKey, configProvider, errorLabel, load, messageApi, runTest, t])

  const handleClear = useCallback(
    (provider: KeyedProvider): void => {
      modalApi.confirm({
        title: t('searchSettings.clearConfirmTitle', { name: providerName(provider) }),
        content: t('searchSettings.clearConfirmBody'),
        okText: t('searchSettings.clearKey'),
        okButtonProps: { danger: true },
        cancelText: t('searchSettings.cancel'),
        onOk: async () => {
          await harnessApi.harness.clearSearchProviderKey(provider).catch(() => null)
          messageApi.success(t('searchSettings.clearSuccess'))
          await load()
        }
      })
    },
    [load, messageApi, modalApi, providerName, t]
  )

  const providers = view?.providers ?? []
  const configUrl = configProvider ? PROVIDER_KEY_URLS[configProvider] : null

  const content = useMemo(() => {
    if (loading) {
      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
          <Spin />
        </div>
      )
    }
    if (!view) return null
    return (
      <>
        <SettingsSection
          title={t('searchSettings.sectionServices')}
          description={t('searchSettings.sectionServicesDesc')}
        >
          {providers.map((state) => {
            const isDefault = view.defaultProvider === state.provider
            return (
              <div
                key={state.provider}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '13px 14px',
                  borderTop: `1px solid ${token.colorBorderSecondary}`
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    flex: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: token.colorFillQuaternary,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    color: token.colorTextSecondary
                  }}
                >
                  {PROVIDER_ICONS[state.provider]}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
                      {providerName(state.provider)}
                    </span>
                    {isDefault && <Tag color="default">{t('searchSettings.currentDefault')}</Tag>}
                    {state.configured ? (
                      <Tag color="success">{t('searchSettings.connected')}</Tag>
                    ) : state.requiresKey ? (
                      <Tag color="warning">{t('searchSettings.notConfigured')}</Tag>
                    ) : null}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      fontSize: 11.3,
                      color: token.colorTextTertiary
                    }}
                  >
                    {providerDesc(state.provider)}
                  </div>
                  {state.requiresKey && !state.configured && state.canReuseModelKey && (
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 11.3,
                        color: token.colorWarning
                      }}
                    >
                      {t('searchSettings.reuseHint')}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    marginLeft: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flex: 'none'
                  }}
                >
                  {state.maskedKey && (
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 6,
                        background: token.colorFillQuaternary,
                        border: `1px solid ${token.colorBorderSecondary}`,
                        fontFamily: 'ui-monospace, Consolas, monospace',
                        fontSize: 11,
                        color: token.colorTextSecondary,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {state.maskedKey}
                    </span>
                  )}
                  {(state.requiresKey || !state.configured) && (
                    <Button
                      size="small"
                      loading={testing === state.provider}
                      disabled={!state.configured}
                      onClick={() => void runTest(state.provider)}
                    >
                      {t('searchSettings.test')}
                    </Button>
                  )}
                  {state.requiresKey && state.configured && (
                    <Button size="small" onClick={() => handleClear(state.provider as KeyedProvider)}>
                      {t('searchSettings.clearKey')}
                    </Button>
                  )}
                  {state.requiresKey && (
                    <Button
                      size="small"
                      type={state.configured ? 'default' : 'primary'}
                      onClick={() => {
                        setConfigProvider(state.provider as KeyedProvider)
                        setConfigKey('')
                      }}
                    >
                      {t('searchSettings.configure')}
                    </Button>
                  )}
                  <Radio
                    checked={isDefault}
                    onChange={() => void selectDefault(state.provider)}
                  />
                </div>
              </div>
            )
          })}
        </SettingsSection>

        <SettingsSection
          title={t('searchSettings.sectionBehavior')}
          description={t('searchSettings.sectionBehaviorDesc')}
        >
          <SettingRow
            title={t('searchSettings.autoFallback')}
            description={t('searchSettings.autoFallbackHint')}
            control={
              <Radio.Group
                value={view.autoFallback ? 'on' : 'off'}
                onChange={(event) => void toggleBehavior({ autoFallback: event.target.value === 'on' })}
                optionType="button"
                buttonStyle="solid"
                size="small"
                options={[
                  { label: t('searchSettings.on'), value: 'on' },
                  { label: t('searchSettings.off'), value: 'off' }
                ]}
              />
            }
          />
          <SettingRow
            title={t('searchSettings.includeContent')}
            description={t('searchSettings.includeContentHint')}
            control={
              <Radio.Group
                value={view.includeContent ? 'on' : 'off'}
                onChange={(event) =>
                  void toggleBehavior({ includeContent: event.target.value === 'on' })
                }
                optionType="button"
                buttonStyle="solid"
                size="small"
                options={[
                  { label: t('searchSettings.on'), value: 'on' },
                  { label: t('searchSettings.off'), value: 'off' }
                ]}
              />
            }
          />
        </SettingsSection>
      </>
    )
  }, [
    handleClear,
    load,
    loading,
    messageApi,
    providerDesc,
    providerName,
    providers,
    runTest,
    selectDefault,
    t,
    testing,
    toggleBehavior,
    token,
    view
  ])

  return (
    <div>
      <SettingsPageHeader
        title={t('searchSettings.pageTitle')}
        description={t('searchSettings.pageDescription')}

      />
      {content}

      <Modal
        open={configProvider !== null}
        title={
          configProvider
            ? t('searchSettings.configTitle', { name: providerName(configProvider) })
            : ''
        }
        onCancel={() => {
          setConfigProvider(null)
          setConfigKey('')
        }}
        confirmLoading={saving}
        okText={t('searchSettings.saveAndTest')}
        cancelText={t('searchSettings.cancel')}
        onOk={() => void handleSaveKey()}
        destroyOnHidden
      >
        <div style={{ fontSize: 12.3, lineHeight: 1.6, color: token.colorTextSecondary }}>
          {t('searchSettings.configDesc')}
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 7 }}>
            {t('searchSettings.keyLabel')}
          </div>
          <Input.Password
            value={configKey}
            autoFocus
            placeholder={t('searchSettings.keyPlaceholder')}
            onChange={(event) => setConfigKey(event.target.value)}
            onPressEnter={() => void handleSaveKey()}
          />
          <div style={{ marginTop: 7, fontSize: 11.3, color: token.colorTextTertiary }}>
            {t('searchSettings.keyHelp', {
              link: t('searchSettings.keyHelpLink')
            })}
            {configUrl && (
              <a
                href={configUrl}
                target="_blank"
                rel="noreferrer"
                style={{ marginLeft: 4, color: token.colorLink }}
              >
                ↗
              </a>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default SearchSettings
