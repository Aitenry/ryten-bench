import { useCallback, useEffect, useState } from 'react'
import { App, Input, Switch } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import type { ${vars.pascal}Settings } from '../shared/types'
import api from './api'
import { SettingRow, SettingsCard } from './components/ui'

/**
 * Settings page for ${vars.title} (Settings -> Assistant -> this plugin).
 *
 * Written like a real built-in plugin so it does not stand out next to the host settings pages:
 * - group with `SettingsCard`, one field per `SettingRow`: label on the left, control on the right,
 *   hint on the line below;
 * - **persist immediately** (no half-done "Save" button state): switches write in onChange, inputs
 *   write on Enter / blur - writing to the main process on every keystroke is noisy and slow;
 * - the main process is the only source of truth: fill back with the returned value on success,
 *   revert to the previous value and show an error on failure;
 * - all UI copy goes through the locale entries (locales/), never hard-coded in components, and do
 *   not explain implementation details such as "this page is registered by the plugin".
 *
 * Shares one main-process state with the page: toggling a switch here is pushed to the page through
 * `items-changed` immediately.
 */
const FALLBACK_SETTINGS: ${vars.pascal}Settings = { hideDone: false, note: '' }

export default function Settings(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [settings, setSettings] = useState<${vars.pascal}Settings>(FALLBACK_SETTINGS)
  /** Input draft: persisted only on Enter / blur (does not compete with the main process for the truth) */
  const [note, setNote] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const next = { ...FALLBACK_SETTINGS, ...(await api.getSettings()) }
    setSettings(next)
    setNote(next.note)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<${vars.pascal}Settings>): Promise<void> => {
    const previous = settings
    // Fill back first so the switch feels responsive; revert to the previous value on failure (on success always trust the value returned by the main process)
    setSettings({ ...previous, ...patch })
    try {
      const next = await api.setSettings(patch)
      setSettings(next)
      // Only fill the input back when this change was the note itself: do not wipe the user's in-progress draft when toggling the switch
      if (patch.note !== undefined) setNote(next.note)
    } catch {
      setSettings(previous)
      setNote(previous.note)
      message.error(t('${vars.id}.settingsPage.saveFailed'))
    }
  }

  const commitNote = (): void => {
    if (note !== settings.note) void save({ note })
  }

  return (
    <div className="w-full">
      <SettingsCard title={t('${vars.id}.settingsPage.section.list')}>
        <SettingRow
          label={t('${vars.id}.settingsPage.hideDoneLabel')}
          hint={t('${vars.id}.settingsPage.hideDoneHint')}
        >
          <Switch
            size="small"
            checked={settings.hideDone}
            onChange={(value) => void save({ hideDone: value })}
          />
        </SettingRow>

        <SettingRow
          label={t('${vars.id}.settingsPage.noteLabel')}
          hint={t('${vars.id}.settingsPage.noteHint')}
        >
          <Input
            size="small"
            className="w-[220px]"
            value={note}
            maxLength={80}
            placeholder={t('${vars.id}.settingsPage.notePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
            onPressEnter={commitNote}
            onBlur={commitNote}
          />
        </SettingRow>
      </SettingsCard>
    </div>
  )
}
