import type { ${vars.pascal}ZhCN } from './zh-CN'

/**
 * ${vars.title} 的英文词条：**逐键对齐** zh-CN（类型就是那么来的，少键/多键都编译不过）。
 */
export const ${vars.pascal}EnUS: typeof ${vars.pascal}ZhCN = {
  '${vars.id}': {
    menu: { title: ${vars.titleJson} },
    settings: { title: ${vars.titleJson} },
    page: {
      title: ${vars.titleJson},
      add: 'New',
      empty: 'Nothing here yet - hit "New" to add one.',
      deleteConfirm: 'Delete this record?',
      moreItems: '{{count}} more (widen the window to see them)',
      on: 'Enabled',
      off: 'Disabled',
      loading: 'Loading…'
    },
    form: {
      createTitle: 'New record',
      editTitle: 'Edit record',
      titleLabel: 'Title',
      titlePlaceholder: 'Write something',
      noteLabel: 'Note',
      notePlaceholder: 'optional'
    },
    settingsPage: {
      intro:
        'This page is registered by the plugin itself (settingsSection); disabling the plugin removes it.',
      enabledLabel: 'Example switch',
      noteLabel: 'Note (persisted on save)',
      save: 'Save',
      storageHint: 'Records live in the app database; settings live under plugin-state in userData.'
    }
  }
}

export default ${vars.pascal}EnUS
