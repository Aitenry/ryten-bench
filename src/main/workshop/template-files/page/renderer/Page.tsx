import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Space, Typography } from 'antd'
import { RiSaveLine, RiRefreshLine } from '@remixicon/react'
import { invoke } from './context'

/**
 * ${vars.title} 的页面。
 *
 * 数据来源是插件自己的主进程通道（plugin:${vars.id}:state-get / plugin:${vars.id}:state-set）——
 * 页面永远不直接读磁盘，跨进程一律走 plugin:<id>:* 通道（契约见 WORKSHOP.md）。
 *
 * 两个容易犯的错（都在 WORKSHOP.md 第 6 节里，验收电池会点名）：
 * 1. **根节点不能带 `overflow-auto`**：宿主的插件容器高度是确定的，根节点自己滚会把标题一起
 *    滚出窗口、并顶出「整页滚动条」。正确写法见下面的根节点 + 正文块（要滚只滚正文块）；
 * 2. **不要用 Tailwind 的 `dark:` 变体做暗色**：插件编出来的 CSS 里 `dark:` 落成的是
 *    `prefers-color-scheme`（跟操作系统配色），而应用主题是宿主自己的一套（还可能按时间切）
 *    ——两者对不上。颜色取 antd token（`theme.useToken()`）或宿主
 *    `@host/renderer/hooks/useTheme` 的 `effectiveTheme`（插件模板 full 的
 *    `renderer/components/ui.tsx` 里有现成的 `usePluginPalette()` 可以直接抄）。
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
    // 根节点：撑满宿主给的高度、自己不滚（整页不出滚动条）
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
