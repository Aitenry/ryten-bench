/* 应用外壳（主窗口框架、路由骨架、构建进度通知）词条。
   注意 errorBoundary.eyebrow 与 routing.loading 是**等宽全大写的装饰性标签**，
   按项目字体规则（等宽只给拉丁与数字）两种语言都保持拉丁大写，不译中文——
   中文落进等宽族会回退成宋体，和页面其它中文不是一套字。 */
export const zhCNShell = {
  menu: {
    // 只保留**内置**插件的菜单文案；独立插件（task-planner / music-player）自带
    // planner.menu.title / music.menu.title（见各自 locales）。
    notes: '笔记',
    harness: '助手'
  },
  nav: {
    library: '资料库',
    pluginRepo: '插件仓库',
    /** 设置从侧栏收起成一个入口（菜单 + 内容都在这一页里） */
    more: '更多内容'
  },
  titleBar: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭',
    /** 自绘标题栏左侧的两个应用菜单（与参考形态一致：应用 / 编辑） */
    app: '应用',
    edit: '编辑',
    settings: '设置…',
    reload: '重新加载',
    quit: '退出',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选'
  },
  rightBar: {
    messages: '消息',
    settings: '设置'
  },
  unlock: {
    title: '系统已锁屏',
    prompt: '输入 6 位锁屏密码继续',
    hint: '输入 6 位数字 · 输满自动解锁',
    success: '解锁成功',
    failed: '密码错误，请重新输入',
    attemptsLeft: '密码错误，还可尝试 {{n}} 次',
    throttled: '尝试过于频繁，请 {{seconds}} 秒后重试',
    unavailable: '锁屏码不可用，请重启应用后再试',
    verifying: '正在验证…',
    verifyFailed: '解锁验证失败，请重试',
    privacyNote: '密码仅在本机校验，不会上传到任何服务器'
  },
  errorBoundary: {
    eyebrow: 'RUNTIME ERROR',
    title: '界面渲染时发生了一个未预期的错误',
    reload: '重新加载'
  },
  pluginBoundary: {
    title: '插件「{{name}}」未能显示',
    detail: '这块界面由插件自己渲染；宿主已把它隔离，其它功能不受影响。',
    retry: '重试',
    disable: '停用插件',
    disableFailed: '停用失败：{{error}}',
    unavailable: '插件暂时不可用'
  },
  windowTitle: {
    library: '资料库',
    pluginRepo: '插件仓库',
    more: '更多内容',
    chatMode: '对话模式',
    workMode: '工作模式',
    pluginMode: '插件模式'
  },
  appearance: {
    toLight: '切换到亮色',
    toDark: '切换到暗色'
  },
  startup: {
    title: 'RytenBench，我帮你',
    preparing: '正在准备你的工作台…',
    failed: '启动失败'
  },
  notificationList: {
    title: '消息',
    markAllRead: '全部已读',
    empty: '暂无消息',
    emptyHint: '任务进度、系统提醒会出现在这里',
    completed: '已完成',
    timeJustNow: '刚刚',
    timeMinutesAgo: '{{count}} 分钟前',
    timeHoursAgo: '{{count}} 小时前'
  },
  miniPlayer: {
    idle: '未在播放'
  },
  bottomBar: {
    music: '音乐',
    weather: '天气',
    refreshWeather: '刷新天气',
    weatherUnavailable: '暂无天气数据',
    apparentTemp: '体感 {{temp}}°C',
    humidity: '湿度 {{percent}}%',
    windSpeed: '风速 {{speed}}km/h'
  },
  routing: {
    loading: 'LOADING'
  },
  build: {
    initializing: '初始化',
    initializingMessage: '初始化...',
    unknownWiki: '知识库 #{{id}}',
    progressSummary: '{{phase}} {{percent}}% — {{message}}',
    completedSummary: '{{entityCount}} 实体, {{relationCount}} 关系',
    completedSummary_one: '{{entityCount}} 实体, {{relationCount}} 关系',
    completedSummary_other: '{{entityCount}} 实体, {{relationCount}} 关系'
  }
}
