import { useCallback, useEffect, useState } from 'react'
import { App, Card, Input, Switch } from 'antd'
import { useTranslation } from '@host/renderer/i18n'
import { invoke } from './context'

/**
 * Settings page for ${vars.title} (Settings -> Assistant -> this plugin).
 *
 * Looks consistent with the built-in plugin settings pages:
 * - group with `Card size="small"` and title each group with what it controls; no decorative group
 *   headings or boxed info blocks;
 * - one field per row: label on the left, control on the right, extra information on the 11px grey
 *   line below the label;
 * - **persist immediately**: switches write in onChange, inputs write on Enter / blur, no "Save"
 *   button;
 * - all copy goes through the locale entries (locales/), never hard-coded in components.
 *
 * This file deliberately depends only on `invoke` from `./context`: the narrow skeleton does not
 * ship `components/ui.tsx`, and with just two settings local Section / Row are enough; extract
 * shared primitives once the fields grow.
 */
interface PanelState {
  enabled: boolean
  note: string
}

/** Group card (same layout as the shared SettingsCard primitive) */
function Section(props: {
  title: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card
      size="small"
      variant="outlined"
      title={props.title}
      styles={{
        header: { minHeight: 42, padding: '0 16px', fontSize: 13, fontWeight: 600 },
        body: { padding: '14px 16px' }
      }}
    >
      <div className="flex flex-col gap-3.5">{props.children}</div>
    </Card>
  )
}

/** One field row: label on the left, control on the right, hint on the line below (same layout as the shared SettingRow) */
function Row(props: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-[24px] items-center justify-between gap-4">
        <span className="text-[13px]">{props.label}</span>
        <div className="flex shrink-0 items-center">{props.children}</div>
      </div>
      {props.hint ? <div className="text-[11px] opacity-60">{props.hint}</div> : null}
    </div>
  )
}

const FALLBACK_STATE: PanelState = { enabled: false, note: '' }

export default function Settings(): React.JSX.Element {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [state, setState] = useState<PanelState>(FALLBACK_STATE)
  /** Input draft: persisted only on Enter / blur */
  const [note, setNote] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const next = (await invoke('plugin:${vars.id}:settings-get')) as Partial<PanelState> | null
    const normalized: PanelState = {
      enabled: Boolean(next?.enabled),
      note: String(next?.note ?? '')
    }
    setState(normalized)
    setNote(normalized.note)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<PanelState>): Promise<void> => {
    const previous = state
    // Fill back first so the switch feels responsive; revert to the previous value on failure (on success trust the value returned by the main process)
    setState({ ...previous, ...patch })
    try {
      const next = (await invoke('plugin:${vars.id}:settings-set', patch)) as PanelState
      const normalized: PanelState = {
        enabled: Boolean(next?.enabled),
        note: String(next?.note ?? '')
      }
      setState(normalized)
      // Only fill the input back when this change was the note itself: do not wipe the user's in-progress draft when toggling the switch
      if (patch.note !== undefined) setNote(normalized.note)
    } catch {
      setState(previous)
      setNote(previous.note)
      message.error(t('${vars.id}.settingsPage.saveFailed'))
    }
  }

  const commitNote = (): void => {
    if (note !== state.note) void save({ note })
  }

  return (
    <div className="w-full">
      <Section title={t('${vars.id}.settingsPage.section.general')}>
        <Row
          label={t('${vars.id}.settingsPage.enabledLabel')}
          hint={t('${vars.id}.settingsPage.enabledHint')}
        >
          <Switch
            size="small"
            checked={state.enabled}
            onChange={(value) => void save({ enabled: value })}
          />
        </Row>

        <Row label={t('${vars.id}.settingsPage.noteLabel')} hint={t('${vars.id}.settingsPage.noteHint')}>
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
        </Row>
      </Section>
    </div>
  )
}
