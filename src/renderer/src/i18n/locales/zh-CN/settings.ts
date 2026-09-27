/* 设置模块（弹窗外壳 + 通用设置页）词条。 */
export const zhCNSettings = {
  title: '设置',
  nav: {
    groupGeneral: '常规',
    groupAssistant: '助手',
    general: '通用',
    model: '模型',
    graph: '图谱',
    system: '系统',
    agents: '智能体',
    skills: '技能',
    memory: '记忆',
    mcp: 'MCP',
    workshop: '插件工坊',
    plugins: '插件'
  },
  plugins: {
    pageTitle: '插件管理',
    pageDescription: '卸载/安装插件，或临时停用某项功能',
    listTitle: '已安装插件',
    listDescription: '停用后对应功能会立即从应用移除，重新启用即时恢复',
    builtinBadge: '内置',
    externalBadge: '第三方',
    switchFail: '插件状态切换失败',
    install: '安装第三方插件',
    reinstall: '安装',
    reinstallDone: '插件已重新安装',
    /** 行内「⋯」菜单 */
    moreActions: '更多操作',
    updateTo: '更新到 v{{version}}',
    reinstallAction: '重新安装',
    updateDone: '「{{name}}」已更新',
    enable: '启用',
    disable: '禁用',
    disabledBadge: '已停用',
    uninstall: '卸载',
    installFail: '插件安装失败',
    uninstallFail: '插件卸载失败',
    uninstallDone: '插件已卸载',
    uninstallTitle: '卸载「{{name}}」',
    uninstallBody: '插件代码会被移除（可在「可安装的内置插件」里重新安装），数据默认保留。',
    purgeCheckbox: '同时删除该插件的全部数据',
    purgeDetail: '包含：{{label}}。此操作不可撤销。',
    purgeDetailFallback: '包含该插件的全部业务数据，此操作不可撤销。',
    purgeHint: '不勾选则只移除插件代码，数据库里的数据原样保留，重新安装后仍然可用。',
    uninstallConfirm: '卸载',
    uninstallKeptData: '插件已卸载，数据已保留',
    installFromRepo: '从插件仓库安装',
    installLocal: '从本地安装',
    localInstalled: '「{{name}}」已安装并启用',
    localUpgraded: '「{{name}}」已升级',
    repoTitle: '插件仓库',
    repoSource: '来源：{{repo}}',
    repoRefresh: '刷新',
    repoLoading: '正在读取插件索引…',
    repoEmpty: '仓库里暂时没有可安装的插件。',
    repoFailed: '读取插件索引失败：{{reason}}',
    repoInstall: '安装',
    repoUpgrade: '升级',
    repoInstalled: '插件已安装',
    repoUpgraded: '插件已升级',
    repoInstalledBadge: '已安装',
    availableTitle: '可安装的内置插件',
    availableDescription: '随应用分发，卸载后可随时装回来'
  },
  general: {
    pageTitle: '通用设置',
    pageDescription: '管理应用的界面语言、主题与安全配置',
    language: {
      sectionTitle: '界面语言',
      sectionDescription: '切换后立即生效，无需重启应用',
      rowTitle: '显示语言',
      rowDescription: '简体中文 / English'
    },
    theme: {
      sectionTitle: '主题模式',
      sectionDescription: '自动模式下，6:00 ~ 18:00 为亮色主题，其余时间为暗色主题',
      rowTitle: '外观',
      rowDescription: '亮色 / 暗色 / 跟随时间段自动切换',
      light: '亮色',
      dark: '暗色',
      auto: '自动'
    },
    tray: {
      sectionTitle: '系统托盘',
      sectionDescription: '关闭窗口时的后台驻留行为',
      rowTitle: '关闭到系统托盘',
      rowDescription:
        '开启后关闭窗口将隐藏到系统托盘继续运行，可随时从托盘图标恢复或退出；关闭后关闭窗口将直接退出应用'
    },
    lock: {
      sectionTitle: '锁屏设置',
      enableTitle: '启用锁屏',
      enableDescription: '关闭后锁屏功能将失效',
      passwordTitle: '锁屏密码',
      passwordDescription: '6 位纯数字密码，修改后旧密码将失效',
      changePassword: '修改密码'
    },
    passwordModal: {
      title: '修改锁屏密码',
      oldPassword: '原密码',
      newPassword: '新密码',
      confirmPassword: '确认新密码',
      oldPasswordRequired: '请输入原密码',
      newPasswordRequired: '请输入新密码',
      confirmPasswordRequired: '请再次输入新密码',
      sixDigits: '密码必须为 6 位纯数字',
      mismatch: '两次输入的密码不一致',
      wrongOldPassword: '原密码错误'
    }
  }
}
