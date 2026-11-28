/**
 * Main-process copy that **shows up in system UI**: the tray menu, native file dialogs, splash
 * step names, and standalone window titles.
 *
 * Not kept here: logs, comments, errors thrown to the renderer (those belong to their own
 * modules), and prompts sent to the model. Chinese is the source language; `enUS` is constrained
 * by `typeof zhCN`, so missing or extra keys are compile-time errors.
 */
import { enUSGraphProgress, zhCNGraphProgress } from './graph-progress'

export const zhCN = {
  tray: {
    tooltip: 'RytenBench — AI 桌面工作台',
    subtitle: 'AI 桌面工作台',
    hideWindow: '隐藏窗口',
    showWindow: '显示主窗口',
    closeToTray: '关闭到系统托盘',
    quit: '退出 RytenBench'
  },
  dialog: {
    unsupportedFileTypeTitle: '不支持的文件类型',
    unsupportedFileTypeMessage: '当前模型不支持视觉识别，请选择文档类附件（pdf、txt、md 等）',
    filterSupportedFiles: '支持的文件',
    filterAllFiles: '所有文件',
    filterTextFiles: '文本文件',
    filterDocumentFiles: '文档文件',
    filterImageFiles: '图片文件',
    filterAudioFiles: '音频文件',
    selectMemoryDir: '选择记忆存储目录',
    selectSkillsDir: '选择技能存储目录',
    selectWorkspaceDir: '选择 AI 工作区目录',
    selectMcpConfig: '选择 MCP 配置文件（mcp.json）',
    selectMusicRoot: '选择音乐根目录',
    selectCoverImage: '选择封面图片',
    selectPlaylistCover: '选择歌单封面',
    selectMusicFiles: '选择音乐文件',
    dbStartupFailedTitle: '数据库无法启动',
    dbStartupFailedMessage: '本地数据库（PGlite）启动失败，可能是数据目录损坏。',
    dbStartupFailedDetail:
      '常见原因：上次退出时被强制结束进程，或同时有另一个进程（如 drizzle-kit studio/push）打开了同一个数据目录。\n\n选择「备份并以空库启动」会把损坏的目录改名留档（不会删除），应用随后以空数据库正常启动；之后可用 `node scripts/recover-pglite.mjs` 尝试从留档目录里抢救会话、文档等数据。\n\n选择「退出应用」则保持现状，什么都不改。',
    dbStartupFailedReset: '备份并以空库启动',
    dbStartupFailedQuit: '退出应用'
  },
  splash: {
    stepLoadConfig: '加载配置',
    stepInitKeystore: '初始化密钥库',
    stepConnectDatabase: '连接数据库',
    stepRunMigrations: '执行数据库迁移',
    stepInitWorkspace: '初始化工作区',
    stepCompleted: '初始化完成'
  },
  window: {
    mermaidPreview: {
      title: 'Mermaid 预览',
      minimize: '最小化',
      maximize: '最大化',
      restore: '还原',
      close: '关闭',
      fit: '居中画布',
      hint: '拖拽平移 · 滚轮缩放 · 双击居中 · Esc 关闭'
    }
  },
  graphProgress: zhCNGraphProgress,
  /** "Open in app" bullet (conversation ⋯ menu): the system file manager's name on each platform, and the reason when none is detected */
  openInApp: {
    explorer: '文件资源管理器',
    finder: '访达',
    fileManager: '文件管理器',
    notAvailable: '没有检测到该应用：可能已被卸载，换一个应用试试'
  },
  /** Error copy thrown to the renderer over IPC and eventually shown as a toast */
  error: {
    musicDirNotSet: '未设置音乐目录',
    playlistNotFound: '歌单不存在',
    trackNotFound: '歌曲不存在',
    fileOutsideMusicDir: '文件不在音乐目录内，已拒绝访问',
    workspaceNotConfigured: '尚未配置工作区，请先在对话页选择工作区目录',
    httpFromProvider: '{{provider}} 返回 HTTP {{status}}',
    fetchModelsFailed: '拉取模型列表失败：{{reason}}',
    invalidStatus: 'status 必须为 0（未开始）/ 1（进行中）/ 2（已完成）',
    invalidPathAbsolute: '路径无效：必须传入 AI 工作区内的绝对路径',
    workspaceDirNotConfigured: '未配置 AI 工作区目录，拒绝文件访问',
    pathOutsideWorkspace: '路径不在 AI 工作区内，已拒绝访问',
    workspacePathNotSelected:
      '该目录不是通过系统选择框选定的，已拒绝将其设为工作区（请重新选择目录）',
    /** Sidebar workspace row "⋯ → Show in folder": the row no longer exists / the directory is gone */
    workspaceNotFound: '工作区不存在：可能已被删除，请刷新后重试',
    workspaceDirMissing: '工作区目录不存在：{{path}}',
    graphModelNotConfigured:
      '未配置图谱构建模型：请先到「系统设置 → 图谱」中选择用于构建知识图谱的大模型。',
    memoryDirNotConfigured: '未配置记忆存储目录',
    turnPersistFailed:
      '对话未能写入本地数据库，本轮已中止（请检查磁盘空间或数据库状态后重试）',
    assistantPersistFailed:
      '本轮答复未能写入本地数据库，刷新后可能丢失（请检查磁盘空间或数据库状态）',
    invalidRequest: '请求参数无效',
    modelNotSelected: '目标模型不存在：请先在聊天界面顶部选择一个可用的 AI 模型。',
    providerNotFound: '目标模型不存在：未找到 ID 为 {{id}} 的供应商配置，或该供应商已被禁用。',
    modelNameMissing: '目标模型不存在：供应商 "{{name}}" 未指定模型名称，请在设置中配置模型。',
    noProviderConfigured: '未配置任何大模型供应商',
    /* Copy written straight into the assistant message when streaming generation fails */
    responseFailed: '获取响应失败：{{reason}}',
    emptyModelResponse: '模型未返回任何内容，请查看日志或重试。'
  },
  /** Footer weather widget: the main-process cache stores weather codes and dates, rendered into copy in the current language before being sent down */
  weather: {
    today: '今天',
    unknown: '未知',
    weekdays: {
      sun: '周日',
      mon: '周一',
      tue: '周二',
      wed: '周三',
      thu: '周四',
      fri: '周五',
      sat: '周六'
    },
    codes: {
      code0: '晴天',
      code1: '大部晴朗',
      code2: '局部多云',
      code3: '多云',
      code45: '有雾',
      code48: '冰雾',
      code51: '小毛毛雨',
      code53: '中毛毛雨',
      code55: '大毛毛雨',
      code56: '小冻毛毛雨',
      code57: '大冻毛毛雨',
      code61: '小雨',
      code63: '中雨',
      code65: '大雨',
      code66: '小冻雨',
      code67: '大冻雨',
      code71: '小雪',
      code73: '中雪',
      code75: '大雪',
      code77: '雪粒',
      code80: '小阵雨',
      code81: '中阵雨',
      code82: '大阵雨',
      code85: '小阵雪',
      code86: '大阵雪',
      code95: '雷暴',
      code96: '小冰雹雷暴',
      code99: '大冰雹雷暴'
    }
  },
  /** Display names and descriptions for the tool dropdown (AgentSettings "default tools"); keys are tool names and unrelated to the description shown to the model */
  tools: {
    get_weather: { label: '天气查询', description: '查询当前实况、逐小时与未来天气预报' },
    get_time: { label: '时间查询', description: '获取当前日期和时间' },
    web_fetch: { label: '网页抓取', description: '抓取一个 URL 并抽取可读正文' },
    web_search: { label: '网页搜索', description: '联网搜索并返回结果链接与摘要' },
    'web-tools': {
      label: '网页抓取与搜索',
      description: '抓取网页正文并联网搜索（合并为一个选择）'
    },
    present: { label: '交付文件', description: '把已完成的文件声明为本次交付物' },
    schedule_create: { label: '创建定时任务', description: '按定点/周期/每日规则自动执行提示词' },
    schedule_list: { label: '定时任务列表', description: '查看全部定时任务' },
    schedule_view: { label: '定时任务详情', description: '查看单个定时任务' },
    schedule_edit: { label: '修改定时任务', description: '更新/暂停/恢复/删除定时任务' },
    'schedule-tasks': {
      label: '定时任务',
      description: '创建、查看、修改、暂停/删除定时任务（合并为一个选择）'
    },
    mcp: { label: 'MCP 服务器', description: '使用所有已连接 MCP 服务器提供的工具与资源' },
    terminal_open: { label: '打开终端', description: '开启一条持久 shell 会话（仅完全权限档）' },
    terminal_send: { label: '终端执行', description: '在持久终端里执行命令并等待输出' },
    terminal_read: { label: '读取终端', description: '读取终端自上次读取以来的新输出' },
    terminal_close: { label: '关闭终端', description: '关闭终端并终止其进程树' },
    terminal_list: { label: '终端列表', description: '查看当前话题的终端会话' },
    run_code: { label: '代码编排', description: '写 JS 批量调用只读工具并返回结果（仅完全权限档）' },
    list_subagent_models: { label: '模型路由', description: '列出已启用的 provider:model 路由与能力' },
    conversation_list: { label: '会话列表', description: '列出当前工作区的最近会话' },
    propose_action: { label: '动作选项', description: '在回答下方给出可点选的动作按钮' },
    manage_materials: {
      label: '资料整理',
      description: '统一整理文档、待办、知识库与图谱；文档支持按行/按区间精修'
    },
    // These 4 workshop tools plus the plugin hub's "release version" are **mode tools**: they never
    // enter the dropdown (auto-mounted in plugin mode; `plugin_release` also requires signing in to
    // the plugin hub). The copy is kept as a fallback so tools listed by name elsewhere still get a label.
    plugin_draft: { label: '插件草稿', description: '新建插件草稿、读写草稿里的文件' },
    plugin_build: { label: '构建插件', description: '把草稿构建成可安装的插件包并做静态体检' },
    plugin_verify: { label: '验收插件', description: '跑自动化验收电池，确认插件真的能用' },
    plugin_publish: { label: '发布插件', description: '把验收过的插件装进应用并启用' },
    plugin_release: { label: '发布版本', description: '把插件发布一个新版本到插件中心（需登录）' }
  },
  /** The "switch model and continue" dialog after model retries fail */
  modelRecovery: {
    header: '模型请求失败',
    question: '当前模型自动重试 {{count}} 次仍失败。请选择要切换的模型，继续完成当前任务：',
    providerDescription: '供应商：{{provider}}',
    abandonLabel: '不换模型，放弃本轮生成',
    abandonDescription: '结束本轮生成（已生成内容保留在界面，不落库）'
  },
  /**
   * Closing explanation for a failed model request: the HTTP status spells out "why retrying
   * stopped / how to fix it", followed by the provider's raw message (withReason) so that
   * classification does not swallow the actual response
   */
  modelFailure: {
    withReason: '{{summary}}（供应商原文：{{reason}}）',
    auth: '模型鉴权失败{{status}}，已停止重试：请检查该供应商的 API Key',
    notFound: '模型不存在或接口地址有误{{status}}，已停止重试',
    rejected: '模型服务拒绝了该请求{{status}}，已停止重试',
    timeout:
      '模型响应超时{{status}}（等待 {{seconds}} 秒仍未返回），重试 {{count}} 次仍失败：模型可能未加载或响应过慢',
    rateLimit: '模型服务限流或额度不足{{status}}，重试 {{count}} 次仍失败：请检查额度或稍后再试',
    server: '模型服务端错误{{status}}，重试 {{count}} 次仍失败',
    network:
      '模型服务不可用（未拿到状态码）{{status}}，重试 {{count}} 次仍失败：请确认服务已启动、接口地址可达',
    other: '模型请求失败'
  }
}

export const enUS: typeof zhCN = {
  tray: {
    tooltip: 'RytenBench — AI Desktop Workspace',
    subtitle: 'AI Desktop Workspace',
    hideWindow: 'Hide window',
    showWindow: 'Show main window',
    closeToTray: 'Close to system tray',
    quit: 'Quit RytenBench'
  },
  dialog: {
    unsupportedFileTypeTitle: 'Unsupported file type',
    unsupportedFileTypeMessage:
      'The current model does not support vision input. Please attach a document (pdf, txt, md, …).',
    filterSupportedFiles: 'Supported files',
    filterAllFiles: 'All files',
    filterTextFiles: 'Text files',
    filterDocumentFiles: 'Documents',
    filterImageFiles: 'Images',
    filterAudioFiles: 'Audio',
    selectMemoryDir: 'Select the memory folder',
    selectSkillsDir: 'Select the skills folder',
    selectWorkspaceDir: 'Select the AI workspace folder',
    selectMcpConfig: 'Select an MCP config file (mcp.json)',
    selectMusicRoot: 'Select the music root folder',
    selectCoverImage: 'Select a cover image',
    selectPlaylistCover: 'Select a playlist cover',
    selectMusicFiles: 'Select music files',
    dbStartupFailedTitle: 'Database failed to start',
    dbStartupFailedMessage:
      'The local database (PGlite) could not start — its data directory may be corrupted.',
    dbStartupFailedDetail:
      'Common causes: the previous run was force-killed, or another process (e.g. drizzle-kit studio/push) had the same data directory open.\n\n"Back up and start empty" renames the corrupted directory out of the way (nothing is deleted) and starts the app with a fresh database; you can later try `node scripts/recover-pglite.mjs` to salvage conversations and documents from the archived directory.\n\n"Quit" changes nothing and exits the app.',
    dbStartupFailedReset: 'Back up and start empty',
    dbStartupFailedQuit: 'Quit'
  },
  splash: {
    stepLoadConfig: 'Loading configuration',
    stepInitKeystore: 'Initializing keystore',
    stepConnectDatabase: 'Connecting to the database',
    stepRunMigrations: 'Running database migrations',
    stepInitWorkspace: 'Initializing workspace',
    stepCompleted: 'Initialization complete'
  },
  window: {
    mermaidPreview: {
      title: 'Mermaid preview',
      minimize: 'Minimize',
      maximize: 'Maximize',
      restore: 'Restore',
      close: 'Close',
      fit: 'Center canvas',
      hint: 'Drag to pan · Scroll to zoom · Double-click to center · Esc to close'
    }
  },
  graphProgress: enUSGraphProgress,
  openInApp: {
    explorer: 'File Explorer',
    finder: 'Finder',
    fileManager: 'File Manager',
    notAvailable: 'That app was not detected. It may have been uninstalled — try another one.'
  },
  error: {
    musicDirNotSet: 'No music folder is configured',
    playlistNotFound: 'Playlist not found',
    trackNotFound: 'Track not found',
    fileOutsideMusicDir: 'The file is outside the music folder — access denied',
    workspaceNotConfigured:
      'No workspace configured yet. Pick a workspace folder on the assistant page first.',
    httpFromProvider: '{{provider}} returned HTTP {{status}}',
    fetchModelsFailed: 'Failed to fetch the model list: {{reason}}',
    invalidStatus: 'status must be 0 (not started) / 1 (in progress) / 2 (done)',
    invalidPathAbsolute: 'Invalid path: an absolute path inside the AI workspace is required',
    workspaceDirNotConfigured: 'No AI workspace folder configured — file access denied',
    pathOutsideWorkspace: 'The path is outside the AI workspace — access denied',
    workspacePathNotSelected:
      'This folder was not picked through the system folder dialog, so it cannot be used as the workspace (please pick it again)',
    workspaceNotFound: 'Workspace not found — it may have been deleted. Refresh and try again.',
    workspaceDirMissing: 'Workspace folder not found: {{path}}',
    graphModelNotConfigured:
      'No graph building model configured. Choose one under Settings → Graph first.',
    memoryDirNotConfigured: 'No memory storage folder configured',
    turnPersistFailed:
      'The conversation could not be written to the local database, so this turn was aborted (check disk space / database state and retry)',
    assistantPersistFailed:
      'This turn could not be written to the local database and may disappear after a refresh (check disk space / database state)',
    invalidRequest: 'Invalid request parameters',
    modelNotSelected:
      'Target model not found: choose an available AI model at the top of the chat first.',
    providerNotFound:
      'Target model not found: no provider config with ID {{id}}, or the provider is disabled.',
    modelNameMissing:
      'Target model not found: provider "{{name}}" has no model name configured. Configure it in settings first.',
    noProviderConfigured: 'No LLM provider configured.',
    responseFailed: 'Failed to get response: {{reason}}',
    emptyModelResponse: 'The model returned no content. Check the logs or try again.'
  },
  tools: {
    get_weather: {
      label: 'Weather',
      description: 'Current conditions with hourly and daily forecasts'
    },
    get_time: { label: 'Time', description: 'Current date and time' },
    web_fetch: { label: 'Web fetch', description: 'Fetch a URL and read its readable text' },
    web_search: { label: 'Web search', description: 'Search the web and get result links' },
    'web-tools': {
      label: 'Web fetch & search',
      description: 'Fetch a page and search the web (one selection)'
    },
    present: { label: 'Present files', description: 'Declare finished files as deliverables' },
    schedule_create: {
      label: 'Create schedule',
      description: 'Run a prompt on a one-off or recurring schedule'
    },
    schedule_list: { label: 'List schedules', description: 'List the scheduled tasks' },
    schedule_view: { label: 'View schedule', description: 'Show one scheduled task in full' },
    schedule_edit: {
      label: 'Edit schedule',
      description: 'Update, pause, resume or delete a scheduled task'
    },
    'schedule-tasks': {
      label: 'Schedules',
      description: 'Create, list, view and edit scheduled tasks (one selection)'
    },
    mcp: {
      label: 'MCP servers',
      description: 'Use tools and resources from every connected MCP server'
    },
    terminal_open: {
      label: 'Open terminal',
      description: 'Open a persistent shell session (danger-full-access only)'
    },
    terminal_send: {
      label: 'Terminal run',
      description: 'Run a command in the persistent terminal and wait for output'
    },
    terminal_read: {
      label: 'Read terminal',
      description: 'Read output produced since the last read'
    },
    terminal_close: {
      label: 'Close terminal',
      description: 'Close a terminal and terminate its process tree'
    },
    terminal_list: {
      label: 'List terminals',
      description: 'List terminal sessions in this conversation'
    },
    run_code: {
      label: 'Program tool calls',
      description: 'Run JS that calls read-only tools (danger-full-access only)'
    },
    list_subagent_models: {
      label: 'Model routes',
      description: 'List enabled provider:model routes and their capabilities'
    },
    conversation_list: {
      label: 'List conversations',
      description: 'List the recent conversations of this workspace'
    },
    propose_action: {
      label: 'Propose actions',
      description: 'Offer clickable action buttons under the reply'
    },
    manage_materials: {
      label: 'Materials',
      description:
        'Organize documents, to-dos, knowledge bases and graph entities; documents support line/range edits'
    },
    // Mode tools (plugin workshop + plugin hub release): never listed in the tool picker - auto-mounted
    // in plugin mode (`plugin_release` only when signed in to the plugin hub). Kept as fallback
    // labels.
    plugin_draft: {
      label: 'Plugin drafts',
      description: 'Create a plugin draft and edit its files'
    },
    plugin_build: {
      label: 'Build plugin',
      description: 'Build a draft into an installable package and audit it'
    },
    plugin_verify: {
      label: 'Verify plugin',
      description: 'Run the automated acceptance battery on a draft'
    },
    plugin_publish: {
      label: 'Publish plugin',
      description: 'Install a verified plugin into the app and enable it'
    },
    plugin_release: {
      label: 'Release version',
      description: 'Publish a new plugin version to the plugin hub (sign-in required)'
    }
  },
  modelRecovery: {
    header: 'Model request failed',
    question:
      'The current model still fails after {{count}} automatic retries. Pick a model to switch to and finish the current task:',
    providerDescription: 'Provider: {{provider}}',
    abandonLabel: 'Keep the model and abandon this turn',
    abandonDescription: 'End this turn (generated content stays on screen and is not persisted)'
  },
  modelFailure: {
    withReason: '{{summary}} (provider said: {{reason}})',
    auth: 'Model authentication failed{{status}} — retrying stopped. Check this provider\u2019s API key',
    notFound: 'Model not found or wrong endpoint{{status}} — retrying stopped',
    rejected: 'The model service rejected the request{{status}} — retrying stopped',
    timeout:
      'The model timed out{{status}} (no response after {{seconds}}s) — still failing after {{count}} retries. The model may not be loaded or may be too slow',
    rateLimit:
      'The model service is rate limiting or out of quota{{status}} — still failing after {{count}} retries. Check the quota or try again later',
    server:
      'The model service returned a server error{{status}} — still failing after {{count}} retries',
    network:
      'The model service is unavailable (no HTTP status){{status}} — still failing after {{count}} retries. Make sure the server is running and the base URL is reachable',
    other: 'The model request failed'
  },
  weather: {
    today: 'Today',
    unknown: 'Unknown',
    weekdays: {
      sun: 'Sun',
      mon: 'Mon',
      tue: 'Tue',
      wed: 'Wed',
      thu: 'Thu',
      fri: 'Fri',
      sat: 'Sat'
    },
    codes: {
      code0: 'Clear sky',
      code1: 'Mainly clear',
      code2: 'Partly cloudy',
      code3: 'Overcast',
      code45: 'Fog',
      code48: 'Depositing rime fog',
      code51: 'Light drizzle',
      code53: 'Moderate drizzle',
      code55: 'Dense drizzle',
      code56: 'Light freezing drizzle',
      code57: 'Dense freezing drizzle',
      code61: 'Slight rain',
      code63: 'Moderate rain',
      code65: 'Heavy rain',
      code66: 'Light freezing rain',
      code67: 'Heavy freezing rain',
      code71: 'Slight snow',
      code73: 'Moderate snow',
      code75: 'Heavy snow',
      code77: 'Snow grains',
      code80: 'Slight rain showers',
      code81: 'Moderate rain showers',
      code82: 'Violent rain showers',
      code85: 'Slight snow showers',
      code86: 'Heavy snow showers',
      code95: 'Thunderstorm',
      code96: 'Thunderstorm with slight hail',
      code99: 'Thunderstorm with heavy hail'
    }
  }
}
