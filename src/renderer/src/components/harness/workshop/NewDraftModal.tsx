import React, { useEffect, useState } from 'react'
import { Input, Modal, theme } from 'antd'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import { harnessApi } from '../../../api/harness'

/**
 * Matches the rule of `assertDraftId` in the main process `workshop/paths.ts`:
 * lowercase kebab only (no consecutive `-`, must not end with `-`), at most 40 characters, and
 * host-reserved ids plus Windows device names are not allowed. The frontend used to check only
 * `/^[a-z][a-z0-9-]*$/`, so `foo-` or a 41-character name could click "Create" and was only
 * rejected in the main process — the user just saw an inexplicable failure.
 */
const DRAFT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const DRAFT_ID_MAX = 40
const RESERVED_DRAFT_IDS = new Set([
  'host',
  ...['con', 'prn', 'aux', 'nul'],
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
])

function isValidDraftId(value: string): boolean {
  const id = value.trim()
  if (!id || id.length > DRAFT_ID_MAX) return false
  if (!DRAFT_ID_RE.test(id)) return false
  if (RESERVED_DRAFT_IDS.has(id)) return false
  return true
}

/**
 * The "New draft" modal (shared by the sidebar's + and the settings page's "New draft").
 *
 * Both entries share it so that the "click once and start" path needs **only one navigation**:
 * clicking + in the sidebar plugin mode opens this dialog directly (when no plugin storage path is
 * configured, a folder picker opens first; see `handleNewDraft` in the sidebar). The dialog
 * **only asks for id and display name** — choosing the storage path is not here (user requirement
 * 2026-09-27: "don't put a plugin directory picker in new plugin"): there are only two places to
 * pick a folder, each on its own page — the "Plugin storage path" row under Settings → Plugin
 * Workshop, and the + at the top right of the sidebar.
 *
 * Templates are **not selectable** either: generated drafts are always a `full` skeleton with all
 * contents; the assistant deletes whatever is not needed.
 */
const NewDraftModal: React.FC<{
  open: boolean
  onClose: () => void
  /** After creation (panel refresh and sidebar plugin relist each decide how to hook it up) */
  onCreated?: (id: string) => void
}> = ({ open, onClose, onCreated }) => {
  const { token } = theme.useToken()
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [configured, setConfigured] = useState(true)

  // On open, verify the plugin storage path is configured (normally guaranteed by the caller;
  // if missing, disable "Create" and explain)
  useEffect(() => {
    if (!open) return
    void harnessApi.workshop
      .state()
      .then((state) => setConfigured(Boolean(state.pluginsPath)))
      .catch(() => setConfigured(false))
  }, [open])

  /** Id rules match the main process: lowercase kebab (including the length cap / reserved names) */
  const validId = isValidDraftId(id)
  const ready = validId && configured

  const close = (): void => {
    setId('')
    setTitle('')
    onClose()
  }

  const handleCreate = async (): Promise<void> => {
    if (!ready || creating) return
    setCreating(true)
    try {
      const result = await harnessApi.workshop.create({
        id: id.trim(),
        title: title.trim() || undefined
      })
      if (!result.ok) {
        viewMessage('workshop-create', 'error', result.error ?? '', 6)
        return
      }
      const createdId = result.data?.id ?? id.trim()
      close()
      onCreated?.(createdId)
    } catch (error) {
      viewMessage('workshop-create', 'error', String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      title={t('workshopSettings.create.title')}
      okText={t('common.action.create')}
      cancelText={t('common.action.cancel')}
      confirmLoading={creating}
      okButtonProps={{ disabled: !ready }}
      onOk={() => void handleCreate()}
      onCancel={close}
    >
      <div className="flex flex-col" style={{ gap: 12, paddingTop: 8 }}>
        <Input
          value={id}
          onChange={(event) => setId(event.target.value)}
          data-workshop-field="id"
          placeholder={t('workshopSettings.create.idPlaceholder')}
          addonBefore="id"
          autoFocus
        />
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('workshopSettings.create.titlePlaceholder')}
          onPressEnter={() => void handleCreate()}
        />
        <div
          style={{ fontSize: 12, color: configured ? token.colorTextTertiary : token.colorError }}
        >
          {configured ? t('workshopSettings.create.note') : t('workshopSettings.list.needRoot')}
        </div>
      </div>
    </Modal>
  )
}

export default NewDraftModal
