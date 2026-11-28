import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Space, Typography } from 'antd'
import { RiSaveLine, RiRefreshLine } from '@remixicon/react'
import { invoke } from './context'

/**
 * Page for ${vars.title}.
 *
 * Data comes from the plugin's own main-process channels
 * (plugin:${vars.id}:state-get / plugin:${vars.id}:state-set) — the page never reads the disk
 * directly; everything cross-process goes through plugin:<id>:* channels.
 *
 * Two easy mistakes (both named by the acceptance battery):
 * 1. **The root node must not use `overflow-auto`**: the host's plugin container has a fixed
 *    height, so a scrolling root drags the title out of the window and produces a full-page
 *    scrollbar. Use the root + body block below instead (only the body scrolls).
 * 2. **Do not use Tailwind's `dark:` variant for dark mode**: in the CSS the plugin builds,
 *    `dark:` compiles to `prefers-color-scheme` (follows the OS color scheme), while the app
 *    theme is the host's own (and may switch by time of day) — the two never line up. Take
 *    colors from antd tokens (`theme.useToken()`) or the host
 *    `@host/renderer/hooks/useTheme` `effectiveTheme` (the full plugin template's
 *    `renderer/components/ui.tsx` has a ready-made `usePluginPalette()` to copy).
 */
export default function Page(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const state = (await invoke('plugin:${vars.id}:state-get')) as { value?: string } | null
      setValue(state?.value ?? '')
      setSaved(state?.value ?? '')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const state = (await invoke('plugin:${vars.id}:state-set', value)) as { value?: string }
      setSaved(state?.value ?? '')
    } finally {
      setBusy(false)
    }
  }

  return (
    // Root: fill the height the host provides and do not scroll itself (no page-level scrollbar)
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden p-6">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          <Typography.Title level={4} style={{ margin: 0 }}>
            ${vars.title}
          </Typography.Title>
          <Card size="small">
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Typography.Text type="secondary">
                {saved ? '已保存：' + saved : '还没有保存过内容'}
              </Typography.Text>
              <Input.TextArea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoSize={{ minRows: 4, maxRows: 12 }}
                placeholder="写点什么，保存后重启仍然在"
              />
              <Space>
                <Button type="primary" icon={<RiSaveLine size={16} />} loading={busy} onClick={save}>
                  保存
                </Button>
                <Button icon={<RiRefreshLine size={16} />} onClick={() => void load()}>
                  重新读取
                </Button>
              </Space>
            </Space>
          </Card>
        </div>
      </div>
    </div>
  )
}
