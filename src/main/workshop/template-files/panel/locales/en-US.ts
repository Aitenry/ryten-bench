import type { ${vars.pascal}ZhCN } from './zh-CN'

/** ${vars.title} 的英文词条：逐键对齐 zh-CN（类型就是那么来的）。 */
export const ${vars.pascal}EnUS: typeof ${vars.pascal}ZhCN = {
  '${vars.id}': {
    settings: { title: ${vars.titleJson} },
    settingsPage: {
      section: { general: 'General' },
      enabledLabel: 'Enabled',
      enabledHint: 'Changes save as you make them - there is no Save button.',
      noteLabel: 'Note',
      notePlaceholder: 'A short note to yourself',
      noteHint: 'Stored on this device; removed when the plugin is uninstalled with "delete data".',
      saveFailed: 'Could not save. Try again.'
    }
  }
}

export default ${vars.pascal}EnUS
