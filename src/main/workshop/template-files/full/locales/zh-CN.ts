/**
 * Chinese entries for ${vars.title}.
 *
 * Top-level key = plugin id, and the structure inside is up to you - the host UI only reads it via
 * labelKey (for example the menu labelKey is `${vars.id}.menu.title`).
 * The English file must be **aligned key for key** (one missing key and switching to English shows
 * the raw key name).
 *
 * Wording (shared by the settings page and the page): labels are noun phrases ("Hide completed"),
 * hints state **what it affects** ("only affects the list display, records are not deleted"), no
 * implementation details, and no words like "example" or "template".
 */
export const ${vars.pascal}ZhCN = {
  '${vars.id}': {
    menu: { title: ${vars.titleJson} },
    settings: { title: ${vars.titleJson} },
    page: {
      title: ${vars.titleJson},
      add: '新建',
      empty: '还没有记录，点「新建」加一条。',
      emptyFiltered: '没有未完成的记录。',
      deleteConfirm: '删除这条记录？',
      moreItems: '还有 {{count}} 项（窗口拉高就能看到）',
      overview: '概览',
      records: '记录',
      pending: '待完成',
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
      section: { list: '列表' },
      hideDoneLabel: '隐藏已完成',
      hideDoneHint: '只影响列表显示，记录不会被删除。',
      noteLabel: '页面备注',
      notePlaceholder: '写一句给自己看的说明',
      noteHint: '显示在页面右侧的概览面板里，留空则不显示。',
      saveFailed: '保存失败，请重试。',
      storageHint: '记录存在应用数据库里，设置存在 userData 的 plugin-state 目录下。'
    }
  }
}

export default ${vars.pascal}ZhCN
