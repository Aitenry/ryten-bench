/* Strings for the app shell (main window frame, route skeleton, build progress notifications).
   Note that errorBoundary.eyebrow and routing.loading are **decorative monospace, all-caps labels**.
   Per the project font rule (monospace is reserved for Latin and digits), they stay Latin uppercase
   in both languages and are never translated into Chinese: Chinese rendered in the monospace family
   falls back to a serif face and no longer matches the other Chinese on the page. */
export const zhCNShell = {
  menu: {
    // Keep menu copy for **built-in** plugins only; standalone plugins (task-planner / music-player)
    // ship their own planner.menu.title / music.menu.title (see their respective locales).
    notes: '笔记',
    harness: '助手'
  },
  nav: {
    library: '资料库',
    pluginRepo: '插件仓库',
    schedules: '定时任务',
    /** Settings collapse into a single sidebar entry (both menu and content live on this page) */
    more: '更多内容'
  },
  titleBar: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭',
    /** The two application menus on the left side of the custom title bar (App / Edit) */
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
    schedules: '定时任务',
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
