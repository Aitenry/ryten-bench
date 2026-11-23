import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Switch, Typography } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { ${vars.pascal}Settings } from '../shared/types'
import api from './api'

/**
 * ${vars.title} 的设置页（设置 → 助手 → 本插件）。
 *
 * 与页面共用同一份主进程状态：这里改开关，页面那边会通过事件推送同步过去。
 * 界面文案一律走词条（locales/），不写死在组件里。
 */
export default function Settings(): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<${vars.pascal}Settings>({ enabled: true, note: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setSettings(await api.getSettings())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<${vars.pascal}Settings>): Promise<void> => {
    setBusy(true)
    try {
      setSettings(await api.setSettings(patch))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t('${vars.id}.settings.title')}
      </Typography.Title>
      <div className="flex max-w-[560px] flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span>{t('${vars.id}.settingsPage.enabledLabel')}</span>
          <Switch
            size="small"
            checked={settings.enabled}
            onChange={(value) => void save({ enabled: value })}
          />
        </div>
        <Input
          value={settings.note}
          onChange={(event) => setSettings((prev) => ({ ...prev, note: event.target.value }))}
          placeholder={t('${vars.id}.settingsPage.noteLabel')}
        />
        <Button type="primary" loading={busy} onClick={() => void save({ note: settings.note })}>
          {t('${vars.id}.settingsPage.save')}
        </Button>
      </div>
    </div>
  )
}
