import { useCallback, useEffect, useState } from 'react'
import { App, Button, Checkbox, Empty, Tabs, Typography } from 'antd'
import { RiAddLine, RiDeleteBin6Line, RiRefreshLine } from '@remixicon/react'
import { useTranslation } from '@host/renderer/i18n'
import type { ${vars.pascal}Item, ${vars.pascal}ItemInput, ${vars.pascal}Settings } from '../shared/types'
import api from './api'
import ItemForm from './components/ItemForm'
import { EmptyHint, FitList, HoverRow, PageHeader, PageShell, Pane, Panel, pageTabsProps } from './components/ui'

/**
 * The ${vars.title} page.
 *
 * Data only goes through this plugin's main-process channels (./api); when the main process changes
 * data it pushes `plugin:${vars.id}:items-changed` and this page subscribes to refresh live -
 * toggling a switch on the settings page updates this page too.
 *
 * Three layout rules (the host container height is fixed; do not break out of it):
 * 1. the root node does not scroll (PageShell already guarantees it) - do **not** add
 *    `overflow-auto` to the root node;
 * 2. "content taller than the window" is not solved with a scrollbar but by FitList / FitTable
 *    drawing fewer rows for the available height;
 * 3. take colors from usePluginPalette(), never literal color values (a hard-coded light color means
 *    white text on white in dark themes).
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

  // Main-process push: reload when records change (subscribing only works if the plugin main process declared the event channel via registerEvent)
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

  const pendingCount = items.filter((item) => !item.done).length
  // The settings page's "hide completed" really applies to this list: it only changes the display, records stay untouched
  const visibleItems = settings?.hideDone ? items.filter((item) => !item.done) : items

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
                  {/* Column layouts always use grid-cols-12 with a fixed col-span: switching the
                      column count with Tailwind breakpoints makes narrow windows fall back to a
                      single column and stack panels vertically, which inevitably overflows. */}
                  <Panel
                    className="col-span-8"
                    title={t('${vars.id}.page.title')}
                    extra={<span className="text-xs opacity-60">{items.length}</span>}
                  >
                    {/* The list greedily fills rows by available height: rows that do not fit are
                        not drawn, and a "N more" line closes the list */}
                    <FitList
                      items={visibleItems}
                      rowHeight={38}
                      keyOf={(item) => item.id}
                      empty={
                        loading ? null : (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description={
                              items.length === 0
                                ? t('${vars.id}.page.empty')
                                : t('${vars.id}.page.emptyFiltered')
                            }
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
                          {/* Cell content must shrink with the column width: min-w-0 + truncate;
                              a fixed-width block (shrink-0) pushes content into the next column */}
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

                  <Panel className="col-span-4" title={t('${vars.id}.page.overview')}>
                    {settings ? (
                      <div className="flex min-h-0 flex-col gap-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="opacity-60">{t('${vars.id}.page.records')}</span>
                          <span>{items.length}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="opacity-60">{t('${vars.id}.page.pending')}</span>
                          <span>{pendingCount}</span>
                        </div>
                        {/* The page note written on the settings page is shown here (an empty string takes no line) */}
                        {settings.note ? (
                          <div className="min-w-0 truncate opacity-60">{settings.note}</div>
                        ) : null}
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
