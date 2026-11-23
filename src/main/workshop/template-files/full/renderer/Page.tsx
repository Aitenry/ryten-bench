import { useCallback, useEffect, useState } from 'react'
import { App, Button, Checkbox, Empty, Tabs, Tag, Typography } from 'antd'
import { RiAddLine, RiDeleteBin6Line, RiRefreshLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { ${vars.pascal}Item, ${vars.pascal}ItemInput, ${vars.pascal}Settings } from '../shared/types'
import api from './api'
import ItemForm from './components/ItemForm'
import { EmptyHint, FitList, HoverRow, PageHeader, PageShell, Pane, Panel, pageTabsProps } from './components/ui'

/**
 * ${vars.title} 的页面。
 *
 * 数据只走本插件的主进程通道（./api）；主进程改数据会推 `plugin:${vars.id}:items-changed`，
 * 这里订阅它做实时刷新——设置页那边改开关，这一页也会跟着变。
 *
 * 布局三条纪律（宿主容器高度是确定的，别把它撑破）：
 * 1. 根节点不滚（PageShell 已经保证）——**不要**给根节点加 `overflow-auto`；
 * 2. 「内容比窗口多」不靠滚动条解决，靠 FitList / FitTable 按可用高度少画几行；
 * 3. 颜色从 usePluginPalette() 取，不写字面量色值（写死的浅色在暗色主题下就是白底白字）。
 */
export default function Page(): React.JSX.Element {
  const { t } = useTranslation()
  const { modal } = App.useApp()
  const [items, setItems] = useState<${vars.pascal}Item[]>([])
  const [settings, setSettings] = useState<${vars.pascal}Settings | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<${vars.pascal}Item | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextItems, nextSettings] = await Promise.all([api.list(), api.getSettings()])
      setItems(nextItems)
      setSettings(nextSettings)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 主进程推送：记录变了就重拉（事件通道由插件主进程 registerEvent 声明过才订阅得到）
  useEffect(() => api.onItemsChanged(() => void load()), [load])

  const submit = async (input: ${vars.pascal}ItemInput): Promise<void> => {
    setSaving(true)
    try {
      if (editing) await api.update(editing.id, input)
      else await api.create(input)
      setFormOpen(false)
      setEditing(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (item: ${vars.pascal}Item, done: boolean): Promise<void> => {
    setItems((previous) => previous.map((row) => (row.id === item.id ? { ...row, done } : row)))
    await api.update(item.id, { done })
    await load()
  }

  const remove = (item: ${vars.pascal}Item): void => {
    modal.confirm({
      title: t('${vars.id}.page.deleteConfirm'),
      okText: t('common.action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        await api.remove(item.id)
        await load()
      }
    })
  }

  return (
    <PageShell
      header={
        <PageHeader
          title={t('${vars.id}.page.title')}
          extra={
            <>
              <Button
                size="small"
                icon={<RiRefreshLine size={14} />}
                loading={loading}
                onClick={() => void load()}
              >
                {t('common.action.refresh')}
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<RiAddLine size={14} />}
                onClick={() => {
                  setEditing(null)
                  setFormOpen(true)
                }}
              >
                {t('${vars.id}.page.add')}
              </Button>
            </>
          }
        />
      }
    >
      <Tabs
        {...pageTabsProps}
        items={[
          {
            key: 'items',
            label: t('${vars.id}.page.title'),
            children: (
              <Pane>
                <div className="grid h-full min-h-0 grid-cols-12 grid-rows-1 gap-3">
                  {/* 列布局一律 grid-cols-12 + 固定 col-span：用 Tailwind 断点切栏数，
                      窗口一窄就退回单列、面板竖着堆，必然溢出。 */}
                  <Panel
                    className="col-span-8"
                    title={t('${vars.id}.page.title')}
                    extra={<span className="text-xs opacity-60">{items.length}</span>}
                  >
                    {/* 列表按可用高度贪心塞行：放不下的不画，末尾用「还有 N 项」收尾 */}
                    <FitList
                      items={items}
                      rowHeight={38}
                      keyOf={(item) => item.id}
                      empty={
                        loading ? null : (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description={t('${vars.id}.page.empty')}
                            style={{ margin: 0 }}
                          />
                        )
                      }
                      moreLabel={(count) => t('${vars.id}.page.moreItems', { count })}
                      renderItem={(item) => (
                        <HoverRow>
                          <Checkbox
                            checked={item.done}
                            onChange={(event) => void toggle(item, event.target.checked)}
                          />
                          {/* 单元格内容必须能随列宽收缩：min-w-0 + truncate，
                              固定宽度的块（shrink-0）会把内容挤到隔壁列上 */}
                          <button
                            type="button"
                            className="min-w-0 flex-1 cursor-pointer truncate border-none bg-transparent p-0 text-left"
                            onClick={() => {
                              setEditing(item)
                              setFormOpen(true)
                            }}
                          >
                            <span className={item.done ? 'line-through opacity-60' : undefined}>
                              {item.title}
                            </span>
                            {item.note ? (
                              <span className="ml-2 text-xs opacity-60">{item.note}</span>
                            ) : null}
                          </button>
                          <Button
                            size="small"
                            type="text"
                            aria-label={t('common.action.delete')}
                            icon={<RiDeleteBin6Line size={14} />}
                            onClick={() => remove(item)}
                          />
                        </HoverRow>
                      )}
                    />
                  </Panel>

                  <Panel className="col-span-4" title={t('${vars.id}.settings.title')}>
                    {settings ? (
                      <div className="flex min-h-0 flex-col gap-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="opacity-60">{t('${vars.id}.settingsPage.enabledLabel')}</span>
                          <Tag color={settings.enabled ? 'green' : undefined} style={{ marginInlineEnd: 0 }}>
                            {settings.enabled ? t('${vars.id}.page.on') : t('${vars.id}.page.off')}
                          </Tag>
                        </div>
                        <div className="min-w-0 truncate opacity-60">{settings.note || '-'}</div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t('${vars.id}.settingsPage.storageHint')}
                        </Typography.Text>
                      </div>
                    ) : (
                      <EmptyHint text={t('${vars.id}.page.loading')} />
                    )}
                  </Panel>
                </div>
              </Pane>
            )
          }
        ]}
      />

      <ItemForm
        open={formOpen}
        item={editing}
        saving={saving}
        labels={{
          createTitle: t('${vars.id}.form.createTitle'),
          editTitle: t('${vars.id}.form.editTitle'),
          titleLabel: t('${vars.id}.form.titleLabel'),
          titlePlaceholder: t('${vars.id}.form.titlePlaceholder'),
          noteLabel: t('${vars.id}.form.noteLabel'),
          notePlaceholder: t('${vars.id}.form.notePlaceholder'),
          save: t('common.action.save'),
          cancel: t('common.action.cancel')
        }}
        onCancel={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        onSubmit={(input) => void submit(input)}
      />
    </PageShell>
  )
}
