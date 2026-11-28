/**
 * ${vars.title} 的中文词条（面板型插件只有设置页，词条也只有这一组）。
 *
 * 英文那份必须逐键对齐（少一个键，切到英文就会显示原始键名）。
 */
export const ${vars.pascal}ZhCN = {
  '${vars.id}': {
    settings: { title: ${vars.titleJson} },
    settingsPage: {
      section: { general: '常规' },
      enabledLabel: '启用',
      enabledHint: '改动即时保存，不需要点保存按钮。',
      noteLabel: '备注',
      notePlaceholder: '写一句给自己看的说明',
      noteHint: '保存在本机；卸载并勾选删除数据时一并清除。',
      saveFailed: '保存失败，请重试。'
    }
  }
}

export default ${vars.pascal}ZhCN
