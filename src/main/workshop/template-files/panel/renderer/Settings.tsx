import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Space, Switch, Typography } from 'antd'
import { invoke } from './context'

/**
 * ${vars.title} 的设置页。
 *
 * 设置页有三件约定俗成的规矩（跟宿主设置页的观感一致，见 WORKSHOP.md 第 6 节）：
 * 1. **字段顺排**：一行一个字段，标签在左、控件在右，不要装饰性的分组标题与带框信息块；
 * 2. **值进字段本身**（用 placeholder / 说明文字），不要另加一块「当前值：…」的展示面板；
 * 3. **颜色不写字面量**：需要底色/边框时取 antd token（`theme.useToken()`）或宿主
 *    `@host/renderer/hooks/useTheme` 的 `effectiveTheme` —— 写死的浅色在暗色主题下就是白底白字。
 */
interface PanelState {
  enabled: boolean
  note: string
}

export default function Settings(): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ enabled: false, note: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const next = (await invoke('plugin:${vars.id}:settings-get')) as PanelState
    setState({ enabled: Boolean(next?.enabled), note: String(next?.note ?? '') })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<PanelState>): Promise<void> => {
    setBusy(true)
    try {
      const next = (await invoke('plugin:${vars.id}:settings-set', patch)) as PanelState
      setState({ enabled: Boolean(next?.enabled), note: String(next?.note ?? '') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        ${vars.title}
      </Typography.Title>
      <Space direction="vertical" size={12} style={{ width: '100%', maxWidth: 560 }}>
        <div className="flex items-center justify-between gap-4">
          <span>启用示例开关</span>
          <Switch checked={state.enabled} onChange={(v) => void save({ enabled: v })} size="small" />
        </div>
        <Input
          value={state.note}
          onChange={(e) => setState((prev) => ({ ...prev, note: e.target.value }))}
          placeholder="备注（保存后持久化）"
        />
        <Button type="primary" loading={busy} onClick={() => void save({ note: state.note })}>
          保存
        </Button>
      </Space>
    </div>
  )
}
