import type { ${vars.pascal}ZhCN } from './zh-CN'

/** ${vars.title} 的英文词条：逐键对齐 zh-CN（类型就是那么来的）。 */
export const ${vars.pascal}EnUS: typeof ${vars.pascal}ZhCN = {
  '${vars.id}': {
    settings: { title: ${vars.titleJson} },
    settingsPage: {
      section: { tool: 'Tool' },
      toolNameLabel: 'Tool name',
      toolNameHint: 'The name the assistant uses when it calls the tool.',
      enablePathLabel: 'Where to enable',
      enablePathValue: 'Settings -> Agent -> Tools',
      enablePathHint: 'Once checked, the assistant can call it on its next turn.',
      disabledHint: 'Disabling this plugin removes the tool from the assistant right away.'
    }
  }
}

export default ${vars.pascal}EnUS
