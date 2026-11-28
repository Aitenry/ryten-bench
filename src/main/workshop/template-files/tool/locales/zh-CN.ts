/**
 * ${vars.title} 的中文词条（工具型插件只有设置页里的工具说明，词条也只有这一组）。
 *
 * 英文那份必须逐键对齐（少一个键，切到英文就会显示原始键名）。
 */
export const ${vars.pascal}ZhCN = {
  '${vars.id}': {
    settings: { title: ${vars.titleJson} },
    settingsPage: {
      section: { tool: '工具' },
      toolNameLabel: '工具名',
      toolNameHint: '助手在对话里调用它时用的名字。',
      enablePathLabel: '启用位置',
      enablePathValue: '设置 → 智能体 → 工具',
      enablePathHint: '勾选后，助手下一轮对话就能调用它。',
      disabledHint: '停用本插件时，这个工具会立即从助手的可用清单里消失。'
    }
  }
}

export default ${vars.pascal}ZhCN
