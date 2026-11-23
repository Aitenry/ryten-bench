/**
 * ${vars.title} 的中文词条。
 *
 * 顶层键 = 插件 id，里面的结构随你——宿主界面只按 labelKey 取用
 * （例如菜单的 labelKey 是 `${vars.id}.menu.title`）。
 * 英文那份必须**逐键对齐**（少一个键，切到英文就会显示原始键名）。
 */
export const ${vars.pascal}ZhCN = {
  '${vars.id}': {
    menu: { title: ${vars.titleJson} },
    settings: { title: ${vars.titleJson} },
    page: {
      title: ${vars.titleJson},
      add: '新建',
      empty: '还没有记录，点「新建」加一条。',
      deleteConfirm: '删除这条记录？',
      moreItems: '还有 {{count}} 项（窗口拉高就能看到）',
      on: '已启用',
      off: '已停用',
      loading: '读取中…'
    },
    form: {
      createTitle: '新建记录',
      editTitle: '编辑记录',
      titleLabel: '标题',
      titlePlaceholder: '写点什么',
      noteLabel: '备注',
      notePlaceholder: '可选'
    },
    settingsPage: {
      intro: '这一页由插件自己注册（settingsSection 挂载点）；停用插件后这一页随之消失。',
      enabledLabel: '启用示例开关',
      noteLabel: '备注（保存后持久化）',
      save: '保存',
      storageHint: '记录存在应用数据库里，设置存在 userData 的 plugin-state 目录下。'
    }
  }
}

export default ${vars.pascal}ZhCN
