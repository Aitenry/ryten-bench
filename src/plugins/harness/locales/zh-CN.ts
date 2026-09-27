/**
 * harness 插件词条（简体中文 = 源语言）。
 *
 * 顶层键与原中央词条**完全一致**（`harness` 助手界面 / `agentSettings` 智能体设置页 /
 * `memorySettings` 记忆设置页 / `skillsSettings` 技能设置页），只是从
 * src/renderer/src/i18n/locales/ 搬到了插件目录：
 * 插件 install 时经 `ctx.use('i18n').addResources('translation', harnessLocales)` 注册，
 * 停用插件即不再注册这些键（不再由中央词条无条件打包进首屏）。
 *
 * 注意 `modelSettings`（「模型」设置页）属于 core，不在此列。
 */
export const harnessZhCN = {
  /* ── harness（原 locales/zh-CN/harness.ts） ── */
  /* 「助手（harness）」模块词条（由助手模块负责填充）。
     命名约定：t('harness.<group>.<key>')，键名一律 camelCase，不写中文。 */
  harness: {
    index: {
      setupWorkspaceTitle: '配置工作区后开始对话',
      setupWorkspaceDescription:
        '会话记录与记忆按工作区隔离。选择一个目录作为工作区后即可开始，其他功能不受影响。',
      setupWorkspaceButton: '选择工作区目录',
      setupModelTitle: '配置模型后开始对话',
      setupModelDescription:
        'AI 对话需要模型供应商。添加并启用至少一个模型后即可使用，其他功能不受影响。',
      setupModelButton: '去配置模型'
    },
    sidebar: {
      title: '工作区',
      searchPlaceholder: '搜索工作区与会话',
      searchDraftPlaceholder: '搜索插件草稿',
      searchTooltip: '搜索工作区与会话',
      exitSearch: '退出搜索',
      assistantSettings: '助手设置',
      newWorkspace: '新建工作区',
      mode: {
        chat: '工作',
        plugin: '插件',
        chatHint: '工作模式：工作区与会话',
        pluginHint: '插件模式：插件工坊里的草稿（点一行打开它的详情）'
      },
      newDraft: '新建插件草稿',
      noDraft: '还没有插件草稿。在助手对话里说「帮我做一个…插件」，或点右上角新建。',
      needPluginsPath: '先点右上角 ＋ 选择插件存放路径，然后就能新建插件了',
      draftActions: '草稿操作',
      pluginState: {
        draft: '草稿',
        built: '已构建',
        verified: '已验收',
        verifyFailed: '验收未过 {{failed}} 项',
        enabled: '使用中',
        disabled: '已停用'
      },
      noWorkspace: '尚未配置工作区',
      noMatchResult: '无匹配结果',
      noMatchTopic: '无匹配会话',
      emptyTopics: '暂无会话',
      topicDeleteBlocked: '进行中，无法删除',
      topicDelete: '删除会话',
      topicRunning: '会话进行中',
      topicActions: '会话操作',
      workspaceActions: '工作区操作',
      workspaceHasRunning: '有会话进行中',
      workspaceDelete: '删除工作区',
      workspaceDeleteConfirmTitle: '删除工作区',
      workspaceDeleteConfirmContent:
        '确定要删除「{{name}}」吗？该工作区下的所有会话与记忆也将被删除。',
      newSession: '新建会话',
      renameWorkspace: '重命名工作区',
      workspaceNamePlaceholder: '工作区名称',
      workspaceNameRequired: '请输入工作区名称',
      renameSuccess: '工作区已重命名',
      renameFailed: '重命名失败',
      defaultWorkspaceName: '工作区',
      memory: '记忆',
      memoryNotConfigured: '未配置记忆目录，模型将没有持久记忆。',
      memoryGoSettings: '前往设置配置记忆',
      memoryUserProfile: '用户画像',
      memoryProject: '项目记忆',
      memoryEmpty: '暂无热记忆，对话时可直接告诉模型要记住的内容',
      memoryCount: '{{count}} 条',
      memoryHotEmpty: '热记忆 -',
      memoryHotCount: '{{count}} 条热记忆',
      memorySpaces: '空间 {{active}}/{{total}} 激活',
      memoryDocuments: '档案 {{count}}',
      memoryManage: '管理记忆',
      timeJustNow: '刚刚',
      timeMinutes: '{{count}}分钟',
      timeHours: '{{count}}小时',
      timeDays: '{{count}}天',
      timeDate: '{{month}}月{{day}}日',
      timeFullDate: '{{year}}/{{month}}/{{day}}'
    },
    input: {
      placeholder: '给 Rita 发送消息',
      attachTooltip: '上传附件',
      modelPlaceholder: '选择模型',
      modelLabel: '模型',
      modelSearchPlaceholder: '搜索模型',
      modelEmpty: '没有匹配的模型',
      modelMenuAria: '选择模型与推理等级',
      effortLabel: '推理等级',
      effortNotSentHint: '当前接口协议不下发该参数，仅记录',
      effortSaveFailed: '推理等级保存失败',
      back: '返回',
      stopTooltip: '停止生成',
      queueTooltip: '生成中发送会进入插话队列',
      visionUnsupported: '当前模型不支持视觉识别，无法粘贴图片附件',
      imageReadFailed: '读取图片附件失败：{{name}}',
      filePathUnavailable: '无法获取「{{name}}」的本地路径，请通过拖拽或上传按钮添加',
      pasteImageFallbackName: 'paste-image.png',
      permissionAria: '选择权限模式',
      permissionLabel: '权限'
    },
    permission: {
      readOnly: '仅可查看',
      workspaceWrite: '工作区内修改',
      fullAccess: '完全权限',
      readOnlyHint: '只读：写入与危险命令一律拦截，模型可申请一次提权',
      fullAccessHint: '不再拦截：文件改动与命令直接执行',
      confirmTitle: '确认启用完全权限？',
      confirmBody:
        '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
      confirmOk: '启用完全权限',
      confirmCancel: '取消',
      defaultLabel: '默认权限模式',
      defaultHint: '之后新建的会话使用这个档位；当前会话可在输入框左下角单独切换',
      switchFailed: '权限模式切换失败'
    },
    sandbox: {
      label: '沙箱',
      full: '完整强制',
      partial: '部分强制',
      unavailable: '不可用',
      fullHint: '写入限制由操作系统强制执行：工作区之外一律拒绝',
      partialHint:
        '写入限制由操作系统强制执行；受限令牌保留了 Everyone 且 NTFS 硬链接可别名，因此属部分强制（已知边界）',
      unavailableHint: '当前平台拿不到内核级隔离，命令会被拒绝执行（不会静默放行）：{{reason}}',
      backendWindows: 'Windows 受限令牌 + ACL',
      backendBwrap: 'Linux bubblewrap',
      backendLandlock: 'Linux Landlock',
      backendSeatbelt: 'macOS Seatbelt'
    },
    approval: {
      title: '需要你的许可',
      toolLabel: '工具',
      detailLabel: '本次操作',
      allowOnce: '允许一次',
      deny: '拒绝',
      escalationNote: '模型申请临时提权到「{{mode}}」：{{justification}}',
      footerHint: '只放行这一次；同样的操作再次出现时还会问你。点「停止生成」可中止本轮。'
    },
    queue: {
      count: '{{count}} 条排队消息',
      hint: '生成中发送的消息先排在这里',
      heldHint: '未及插话，将随下一次发送带出',
      steered: '已插话',
      edit: '编辑',
      save: '保存',
      cancelEdit: '取消',
      remove: '删除',
      editFailed: '排队消息修改失败',
      steer: '立即插话（并入当前这轮）',
      steerUnavailable: '当前没有生成中的回合，这条会在下一轮发出',
      attachmentCount: '[{{count}} 个附件] '
    },
    header: {
      toggleSidebar: '侧边栏',
      togglePanel: '工作区面板'
    },
    messageArea: {
      scrollToBottom: '回到底部',
      showEarlier: '显示更早的 {{count}} 条消息'
    },
    messageLocator: {
      jumpToRound: '跳转到第 {{round}} 轮',
      emptyMessage: '（空消息）',
      noAnswer: '（暂无回答）',
      codePlaceholder: ' [代码] ',
      imagePlaceholder: ' [图片] '
    },
    welcome: {
      title: '你好，我是 Rita～',
      subtitleWeather: '今天天气怎么样？要是还不错，我帮你把明天的日程也排了～',
      subtitleDocument: '我可以帮你分析文档，提取关键信息，理清它们之间的关系。',
      subtitleTodo: '有什么重要的事尽管说，我帮你记着，并形成代办事项。',
      subtitleKnowledge: '我可以帮你整理零散的文档，构建相应的知识库。'
    },
    loading: {
      generating: '正在生成...'
    },
    assistantMessage: {
      toolCallFallback: '工具调用',
      toolPreparing: '参数构建中…',
      toolExecuting: '执行中…',
      thinkingInProgress: '思考中…',
      thinkingDone: '思考过程',
      foldExpand: '展开全部',
      foldCollapse: '收起',
      retrying: '正在重试（第 {{attempt}}/{{retries}} 次）…',
      compacting: '正在压缩早期对话…',
      compacted: '早期对话已压缩',
      compactedCounts: '<mono>{{compressed}}</mono> 条 → 保留 <mono>{{retained}}</mono> 条',
      memoryInjected: '注入记忆 · <mono>{{count}}</mono> 条',
      memoryInjectedUser: '（用户画像 <mono>{{user}}</mono> · 项目记忆 <mono>{{memory}}</mono>）',
      memoryInjectedProject: '（项目记忆 <mono>{{count}}</mono>）',
      userProfileBytes: '用户画像 USER（<mono>{{bytes}}</mono> 字节）',
      projectMemoryBytes: '项目记忆 MEMORY（<mono>{{bytes}}</mono> 字节）',
      toolInput: '输入：',
      toolOutput: '输出：',
      toolOutputHidden: '共 {{hidden}} 字符未显示',
      longTextTail: '正文过长，仅显示末尾（前 {{hidden}} 字符未显示）',
      toolOutputTotal: '全文 {{total}} 字符',
      toolOutputExpand: '显示全部',
      toolOutputCollapse: '收起',
      dispatched: '已派发后台任务',
      subAgentRunning: '{{name}} · 执行中…',
      subAgentError: '{{name}} · 出错',
      subAgentCompleted: '{{name}} · 已完成',
      subAgentExecuting: '智能体正在执行中…',
      silentGenerating: '正在生成…',
      taskList: '任务清单',
      /** 段头上的改动徽标：段体折起后，这是「这一段改了哪几个文件」唯一的可见入口 */
      changedFiles: '{{count}} 个文件已改',
      changedFilesTip: '这一段改了 {{files}} 个文件 · {{pending}} 处待审查（点击看差异）',
      toolOpenFile: '打开文件',
      toolRevealDir: '在资源管理器中定位',
      toolViewDetail: '查看结果详情',
      toolFailed: '执行失败',
      toolTruncated: ' · 已截断',
      toolLines: '{{count}} 行',
      toolLines_one: '{{count}} 行',
      toolLines_other: '{{count}} 行',
      toolLineRange: '{{start}}-{{end}} / 共 {{total}} 行',
      toolFileCount: '{{count}} 个文件',
      toolFileCount_one: '{{count}} 个文件',
      toolFileCount_other: '{{count}} 个文件',
      toolExitCode: 'exit {{code}}',
      toolReplacements: '<mono>{{count}}</mono> 处',
      toolReplacements_one: '<mono>{{count}}</mono> 处',
      toolReplacements_other: '<mono>{{count}}</mono> 处',
      itemCount: '<mono>{{count}}</mono> 项',
      itemCount_one: '<mono>{{count}}</mono> 项',
      itemCount_other: '<mono>{{count}}</mono> 项',
      matchCount: '<mono>{{count}}</mono> 条',
      matchCount_one: '<mono>{{count}}</mono> 条',
      matchCount_other: '<mono>{{count}}</mono> 条',
      memoryTool: '记忆工具',
      memoryWrite: '记忆写入',
      memoryStatus: '记忆状态',
      memorySpaces: '记忆空间',
      memoryRecall: '记忆召回',
      memoryDocumentSearch: '档案搜索',
      memoryRelated: '关联记忆',
      memoryBodyActivate: '{{active}}/{{total}} 激活',
      memoryBodyHot: '热记忆',
      memoryBodyDocuments: '项目档案',
      memoryBodySpaceFallback: '空间 {{index}}',
      memoryBodyUnnamed: '未命名空间',
      memoryBodyActive: '已激活',
      memoryBodyInactive: '未激活',
      memoryBodyInsights: '<mono>{{count}}</mono> 条洞察',
      memoryBodyInsights_one: '<mono>{{count}}</mono> 条洞察',
      memoryBodyInsights_other: '<mono>{{count}}</mono> 条洞察',
      memoryBodyTotalActive: '共 <mono>{{total}}</mono> 个 · <mono>{{active}}</mono> 激活',
      statusParseFailed: '无法解析状态输出',
      toolOutputParseFailed: '无法解析工具输出',
      memoryBodyEmpty: '暂无记忆空间，可在对话中让模型创建',
      memoryBodyCount: '<mono>{{count}}</mono> 条',
      memoryBodyCount_one: '<mono>{{count}}</mono> 条',
      memoryBodyCount_other: '<mono>{{count}}</mono> 条',
      memoryDocumentCount: '<mono>{{count}}</mono> 份',
      memoryDocumentCount_one: '<mono>{{count}}</mono> 份',
      memoryDocumentCount_other: '<mono>{{count}}</mono> 份',
      memoryDocumentActive: '已激活',
      memoryDocumentArchived: '已归档',
      memoryRecallEmpty: '未召回相关记忆',
      memoryDocumentEmpty: '未找到匹配的档案',
      memoryRelatedEmpty: '未找到关联记忆',
      memoryEntrySource: '来源：{{name}}',
      memoryEntryScore: '相关度 {{score}}',
      memoryEntryDepth: '深度 {{depth}}',
      memoryRemembered: '已沉淀到「{{name}}」',
      memoryCategory: '类别：{{category}}',
      memoryImportance: '重要度 {{importance}}'
    },
    messageActions: {
      copied: '已复制',
      copy: '复制',
      feedbackUp: '好的回答',
      feedbackUpMarked: '已标记：好的回答',
      feedbackDown: '有问题的回答',
      feedbackDownMarked: '已标记：有问题的回答',
      feedbackUpRecorded: '已记录：好的回答',
      feedbackDownRecorded: '已记录：有问题的回答',
      feedbackCanceled: '已取消评价',
      saveToMemory: '存入记忆',
      savingToMemory: '正在交给记忆智能体…',
      saveToMemoryEmpty: '这条回答没有可保存的正文',
      saveToMemoryNoTopic: '当前没有话题，无法整理记忆',
      saveToMemoryDisabled: '尚未配置记忆目录，无法存入记忆',
      saveToMemoryNoModel: '没有可用的模型，请先在设置中指定默认模型',
      saveToMemoryStarted: '已交给记忆智能体整理，可在顶部栏查看进度',
      saveToMemoryFailed: '存入记忆失败',
      branch: '在新对话中分支',
      branching: '正在创建分支…',
      deleteTurn: '删除此轮对话',
      deleteConfirmTitle: '确认删除',
      deleteConfirmContent: '将删除这一轮对话，删除后不可恢复。',
      elapsedTooltip: '本轮提问到回答结束的耗时',
      elapsed: '用时 {{elapsed}}',
      elapsedSeconds: '{{seconds}}秒',
      elapsedMinutes: '{{minutes}}分{{seconds}}秒'
    },
    usagePanel: {
      title: '本轮用量',
      route: '提供方 / 模型',
      cacheHit: '缓存命中',
      uncachedInput: '未缓存输入',
      cacheRead: '缓存读取',
      cacheWrite: '缓存写入',
      input: '输入',
      output: '输出',
      reasoning: '其中推理',
      calls: '模型调用',
      callsValue: '{{count}} 次',
      tokensValue: '{{value}} tok'
    },
    goalBar: {
      phaseActive: '进行中',
      phasePaused: '已暂停',
      phaseBlocked: '已阻塞',
      phaseComplete: '已完成',
      blocked: '阻塞（{{code}}）：{{message}}',
      round: '第 {{current}}/{{max}} 轮'
    },
    taskCard: {
      completed: '{{done}}/{{total}} 已完成',
      inProgress: '· {{count}} 进行中'
    },
    userMessage: {
      goalRound: '目标自动续跑 · 第 {{round}} 轮',
      goalPrev: '上一轮',
      goalNext: '下一轮',
      noReply: '未收到回复',
      edit: '编辑这条提问（在气泡内改，回车重发）',
      editHint: 'Enter 发送 · Shift+Enter 换行 · Esc 取消',
      deleteOrphan: '删除这条提问',
      deleteOrphanTitle: '删除这条提问？',
      deleteOrphanContent: '这条提问还没有对应的回复，删除后无法恢复。'
    },
    askQuestion: {
      title: '需要你的确认',
      okText: '提交回答',
      customPlaceholder: '输入你的回答…',
      footerHint: '提交后模型将在本轮对话中继续执行；点「停止生成」可取消提问并中止本轮。'
    },
    modelRecovery: {
      title: '模型请求失败',
      abandon: '放弃本轮',
      continueWithModel: '用所选模型继续',
      searchPlaceholder: '搜索模型名称',
      noMatch: '未找到匹配「{{query}}」的模型',
      noModels: '当前没有可用模型，可在「设置 → 模型」中添加并启用后再试。',
      hint: '切换后将从中断位置用新模型继续执行，不会重发问题或重跑已执行的工具。'
    },
    backgroundAgents: {
      running: '进行中',
      failed: '失败',
      killed: '已停止',
      completed: '已完成',
      runningCount: '{{count}} 进行中',
      completedCount: '{{count}} 已完成',
      failedCount: '{{count}} 失败',
      killedCount: '{{count}} 已停止',
      summarySeparator: '，',
      promptLabel: '任务',
      generating: '正在生成…',
      noOutput: '暂无输出'
    },
    fileExplorer: {
      title: '资源编辑器',
      refresh: '刷新',
      loading: '加载中...',
      empty: '空文件夹',
      openFailed: '打开文件失败',
      saveFailed: '保存文件失败',
      pendingReview: '{{count}} 处待审查',
      /**
       * 标题栏的主口径 = **文件数**。
       *
       * 踩过（用户 2026-09-23 原话「明明就编辑了一个文件，却显示 10 处待审查」）：
       * 「处」在库里是**改动记录条数**——模型每次 write_file / edit_file 各记一条，
       * 同一个文件改 10 次就是 10 条。只显示这个数字，看的人会以为动了 10 个文件。
       */
      pendingFiles: '{{count}} 个文件',
      /** 「1 个文件 · 10 处改动」：文件数是主口径，改动条数退到副口径 */
      pendingSummary: '{{files}} · {{changes}}',
      pendingFilesTip: '有未审查模型改动的文件',
      keepAllTip: '全部保留：清掉待审查标记，磁盘内容保持不变'
    },
    fileEditor: {
      loading: '正在加载编辑器...',
      modeEdit: '编辑',
      modeDiff: '差异',
      wrapTip: '切换自动换行',
      reloadTip: '从磁盘重新载入（丢弃未保存的修改）',
      diskChanged: '磁盘已变化',
      diskChangedTip:
        '该文件在你编辑期间被改动过。保存会以你的版本为准；点「重新载入」可改用磁盘版本。',
      caret: '第 {{line}} 行，第 {{column}} 列',
      selected: '已选 {{count}} 字符',
      lines: '共 {{count}} 行',
      readOnly: '只读',
      modified: '未保存',
      saved: '已保存',
      pendingReview: '{{count}} 处改动待审查',
      mdRich: '富文本',
      mdRichTip: '所见即所得编辑（正文即排版结果）',
      mdSource: '源码',
      mdSourceTip: '编辑 Markdown 源码',
      mdPlaceholder: '开始写点什么…',
      chars: '{{count}} 字'
    },
    fileDiff: {
      stats: '{{count}} 处差异 · +{{added}} −{{removed}}',
      acceptChunk: '保留',
      rejectChunk: '撤销',
      acceptChunkTip: '保留这一处（采用模型的写法）',
      rejectChunkTip: '撤销这一处（还原改动前的写法）',
      keepAll: '全部保留',
      keepAllTip: '保留全部待审查改动，磁盘内容不变',
      keepMixedTip: '保留全部：你已逐处取舍，这份结果会落盘并标记为已保留',
      revertAll: '撤销全部',
      revertAllTip: '把文件还原到最早一次改动之前的内容',
      keepOne: '保留',
      revertToHere: '回到此版本',
      history: '历史（{{count}}）',
      historyTitle: '改动历史',
      historyEmpty: '这个文件还没有改动记录',
      prevChunk: '上一处差异',
      nextChunk: '下一处差异',
      unsaved: '未落盘',
      noSnapshot: '这次改动没有改动前快照（由命令执行或外部修改产生），无法回溯。',
      historicalHint: '正在查看较早的一次改动；保留 / 撤销作用于最新一次待审查改动。',
      revertFailed: '撤销失败',
      applyFailed: '审查结果落盘失败',
      sourceWrite: 'write_file 写入',
      sourceEdit: 'edit_file 修改',
      sourceExecute: '命令执行',
      sourceExternal: '外部改动',
      sourceReview: '审查结果',
      statusPending: '待审查',
      statusKept: '已保留',
      statusReverted: '已撤销',
      statusObsolete: '已失效'
    },
    toolDetail: {
      unavailable: '结果详情不可用（可能已随话题清理）',
      emptyOutput: '（无输出）',
      emptyResult: '（无结果）',
      exitCode: 'exit {{code}}',
      outputFooter: '命令完整输出；超出输出上限的部分在生成时已截断。'
    },
    helpers: {
      toolPreparing: '{{name}} · 参数构建中…',
      toolExecuting: '{{name}} · 执行中…'
    },
    handlers: {
      branchCreating: '正在创建分支会话...',
      branchUntitled: '未命名',
      branchTitle: '分支 · {{title}}',
      branchSuccess: '已分支到新会话（{{count}} 条消息）',
      branchListHint: '已创建分支会话，可在左侧会话列表打开',
      branchFailed: '分支失败',
      sendFailed: '抱歉，发生了错误，请稍后重试。'
    }
  },
  /* ── agentSettings（原 locales/zh-CN/agentSettings.ts） ── */
  /* 智能体设置页词条（由智能体设置页负责填充）。
     命名约定：t('agentSettings.<group>.<key>')，键名一律 camelCase，不写中文。 */
  agentSettings: {
    pageTitle: '智能体',
    pageDescription: '配置主智能体的默认工具与技能，以及可委托任务的子智能体',
    sections: {
      mainAgent: '主智能体',
      subagents: '子智能体'
    },
    main: {
      defaultTools: '默认工具',
      defaultToolsDescription:
        '选择主智能体可用的系统工具；MCP 按服务器整组勾选（名字就是服务器名），里面具体哪几个工具在「MCP」设置页里开关',
      defaultToolsPlaceholder: '选择工具',
      mcpToolsCount: '已启用 {{enabled}}/{{total}}',
      defaultSkills: '默认技能',
      defaultSkillsDescription: '选择主智能体可用的技能',
      defaultSkillsPlaceholder: '选择技能（不选则无技能）',
      saved: '主智能体已保存'
    },
    list: {
      description_one: '共 {{count}} 个，只有开启的智能体才会在对话中生效',
      description_other: '共 {{count}} 个，只有开启的智能体才会在对话中生效',
      newAgent: '新建',
      toolCount_one: '{{count}} 工具',
      toolCount_other: '{{count}} 工具',
      skillCount_one: '{{count}} 技能',
      skillCount_other: '{{count}} 技能'
    },
    form: {
      createTitle: '新建智能体',
      editTitle: '编辑智能体: {{name}}',
      chineseName: '中文名称',
      chineseNamePlaceholder: '如 研究代理（可选）',
      identifier: '英文标识名',
      identifierPlaceholder: '如 research-agent',
      identifierRequired: '请输入英文标识名',
      identifierPattern: '只能包含小写字母、数字和连字符',
      enabled: '启用',
      description: '功能描述',
      descriptionPlaceholder: '描述智能体的功能，主智能体据此决定何时委托任务',
      descriptionRequired: '请输入功能描述',
      systemPrompt: '系统提示词',
      systemPromptPlaceholder: '智能体的系统角色和行为规范',
      systemPromptRequired: '请输入系统提示词',
      tools: '可用工具',
      toolsPlaceholder: '选择智能体可用的系统工具（不选则无工具）',
      model: '模型（可选）',
      modelTooltip: '覆盖主智能体的模型，留空则使用主智能体模型。仅显示非 Embedding 模型',
      modelPlaceholder: '使用主智能体默认模型',
      skills: '技能（可选）',
      skillsTooltip: '从已加载的技能目录中选择智能体可用的技能',
      skillsPlaceholder: '选择智能体可用的技能（不选则无技能）',
      skillsNotConfigured: '未找到技能，请先在技能设置中配置目录',
      skillsNoMatch: '无匹配技能'
    },
    messages: {
      agentUpdated: '智能体已更新',
      agentCreated: '智能体已创建',
      opened: '已开启',
      closed: '已关闭',
      toggleFailedWithReason: '切换失败: {{reason}}',
      deleted: '已删除',
      deleteConfirmTitle: '确认删除智能体"{{name}}"？',
      importEmptyFile: '文件内容为空',
      importInvalidJson: 'JSON 格式错误，请检查',
      importNotArray: 'JSON 内容必须是一个数组',
      importEmptyContent: '导入内容为空',
      importFailedWithReason: '导入过程出错: {{reason}}',
      importStrippedSkippedName: '(缺少 name)',
      importMissingTool: '{{name}}: 工具 [{{items}}] 不存在，已移除',
      importMissingSkill: '{{name}}: 技能 [{{items}}] 不存在，已移除',
      importMissingModel: '{{name}}: 模型 "{{model}}" 不存在，已移除',
      importSummaryImported_one: '成功导入 {{count}} 个智能体',
      importSummaryImported_other: '成功导入 {{count}} 个智能体',
      importSummarySkipped_one: '{{count}} 个被跳过',
      importSummarySkipped_other: '{{count}} 个被跳过',
      importSummaryNone: '未导入任何智能体',
      importSummarySeparator: '，',
      importStrippedTitle: '以下字段已自动剔除不存在的项',
      readFileFailed: '读取文件失败'
    },
    empty: {
      noAgents: '暂无智能体，点击右上角「新建」创建'
    }
  },
  /* ── memorySettings（原 locales/zh-CN/memorySettings.ts） ── */
  /* 记忆设置页词条（Mnemon 三层记忆管理）。 */
  memorySettings: {
    page: {
      title: '记忆（Mnemon）',
      description:
        '三层记忆：热记忆（每轮注入）· 长期记忆空间（按需召回）· 项目档案（完整文档）。存储于记忆根目录下，并按工作区目录隔离（每个工作区一套独立记忆，互不串扰）。'
    },
    storage: {
      sectionTitle: '记忆存储目录',
      placeholder: '例如：E:\\RytenBench\\Memory（留空不启用）',
      browse: '浏览…',
      activePath: '当前已生效：{{path}}',
      saved: '记忆目录已保存',
      cleared: '已清空记忆目录',
      selectFailed: '选择目录失败: {{reason}}'
    },
    enable: {
      sectionTitle: '启用记忆',
      empty: '未配置记忆目录，模型将没有持久记忆。',
      emptyHint: '在上方选择一个目录（例如 E:\\RytenBench\\Memory）并保存即可启用三层记忆。'
    },
    manage: {
      sectionTitle: '记忆管理',
      snapshotFailed: '加载记忆快照失败: {{reason}}'
    },
    tabs: {
      runtime: '热记忆（{{count}}）',
      bodies: '长期空间（{{count}}）',
      documents: '档案（{{count}}）'
    },
    importance: {
      label: '重要性',
      critical: '重要',
      normal: '普通',
      low: '次要'
    },
    runtime: {
      bytes: '{{used}} / {{limit}} 字节',
      count: '{{count}} 条',
      add: '记住',
      emptyUser: '暂无用户画像记忆',
      emptyMemory: '暂无项目记忆',
      removeConfirm: '删除这条记忆？',
      contentRequired: '请输入记忆内容'
    },
    targets: {
      userLabel: '用户画像',
      userDesc: '身份 · 偏好 · 沟通风格',
      userPlaceholder: '输入要记住的用户信息，如：偏好深色主题、喜欢编辑部风格设计',
      userHint: '用户画像容量 4 KiB；重要度高的条目整理时优先保留。',
      memoryLabel: '项目记忆',
      memoryDesc: '决策 · 约定 · 可复用经验',
      memoryPlaceholder: '输入要记住的项目信息，如：重构方案已定稿，底层用 LangChain',
      memoryHint: '项目记忆容量 10 KiB，写满后低优先级条目自动归档到长期空间。'
    },
    bodies: {
      namePlaceholder: '空间名称，如：Blog 项目',
      descriptionPlaceholder: '路由描述：什么内容属于这里、何时召回',
      create: '创建空间',
      nameRequired: '请输入空间名称',
      created: '已创建「{{name}}」',
      empty:
        '暂无记忆空间。模型对话中可通过 mnemon_memory_body_create 工具创建，或在这里手动创建。',
      active: '激活',
      inactive: '未激活',
      unhealthy: '异常',
      stats: '洞察 {{insights}} · 关系 {{edges}} · 已删 {{deleted}}',
      content: '内容',
      participatesInRecall: '参与召回',
      excludedFromRecall: '不参与召回'
    },
    insights: {
      title: '「{{name}}」内容',
      empty: '空间内暂无内容',
      meta: '{{category}} · 重要度 {{importance}} · {{date}}'
    },
    documents: {
      empty:
        '暂无项目档案。模型对话中可通过 mnemon_document_manage 工具创建设计 / 流程 / 交接文档。',
      updatedAt: '更新于 {{time}} · revision {{revision}}'
    },
    mechanism: {
      sectionTitle: '记忆机制说明',
      runtimeTitle: '热记忆',
      runtimeDesc:
        'USER 用户画像（4 KiB）+ MEMORY 项目记忆（10 KiB），每轮自动注入；模型用 mnemon_runtime_memory 工具维护；MEMORY 写满自动归档到长期空间。',
      bodiesTitle: '长期记忆空间',
      bodiesDesc:
        '跨会话稳定洞察，每空间独立数据库 + 四类关系；mnemon_recall 召回、mnemon_remember 沉淀；激活状态控制是否参与召回。',
      documentsTitle: '项目档案',
      documentsDesc:
        '完整 Markdown 文档（设计/流程/交接），active 参与搜索、archived 冷层；mnemon_document_manage 创建，mnemon_document_search 检索。'
    }
  },
  /* ── skillsSettings（原 locales/zh-CN/skillsSettings.ts） ── */
  /* 技能设置页词条（由技能设置页负责填充）。 */
  skillsSettings: {
    pageTitle: '技能（Skills）',
    pageDescription:
      '配置全局技能存储目录，子文件夹将作为独立技能加载；可单独启停每个技能。留空则不启用。',
    dirSectionTitle: '技能存储目录',
    dirSectionDescription: '每个含 SKILL.md 的子目录即为一个技能',
    dirPlaceholder: '例如：D:\\skills（留空不启用）',
    dirCurrent: '当前已生效：{{path}}',
    listTitle: '已发现的技能（{{count}}）',
    listTitle_one: '已发现的技能（{{count}}）',
    listTitle_other: '已发现的技能（{{count}}）',
    emptyDescription: '此目录中未发现任何技能，请确保子目录中包含 {{filename}} 文件',
    savedDir: '技能目录已保存',
    clearedDir: '已清空技能目录'
  },
  /* ── mcpSettings（设置 → MCP 页） ── */
  /* MCP（Model Context Protocol）服务器管理页词条。 */
  mcpSettings: {
    pageTitle: 'MCP',
    pageDescription:
      '接入外部 MCP 服务器（stdio 本地进程或 HTTP/SSE 远程地址），服务器暴露的工具会出现在智能体的工具清单里。状态取最近一次连接结果，需要时点「重新连接」刷新。',
    list: {
      sectionTitle: '服务器',
      newServer: '新增',
      importFile: '导入配置',
      reconnect: '重新连接',
      reconnectDone: '已重新连接 {{count}} 台服务器',
      empty: '还没有 MCP 服务器，点右上角「新增」或「导入配置」接入一台',
      toolCount: '{{count}} 个工具',
      toolCount_one: '{{count}} 个工具',
      toolCount_other: '{{count}} 个工具',
      toolsEnabledCount: '{{total}} 个工具 · 已启用 {{enabled}}',
      edit: '编辑',
      remove: '删除',
      removeConfirmTitle: '删除 MCP 服务器「{{name}}」？',
      removeConfirmBody: '只删除本机的这份配置；不影响该服务器本身。此操作不可撤销。',
      removed: '已删除「{{name}}」',
      enableFailedWithReason: '切换启用状态失败：{{reason}}',
      connectFailed: '连接失败'
    },
    status: {
      ok: '已连接',
      error: '连接失败',
      disabled: '已停用',
      unconfigured: '配置不完整',
      unknown: '未连接'
    },
    /* 字段名（表单标签与详情面板共用；分组标签是纯文本，不带装饰） */
    field: {
      name: '名称',
      namePlaceholder: '如：filesystem / github / postgres',
      nameHint: '工具名前缀取自这里，建议用英文与连字符',
      description: '说明（可选）',
      descriptionPlaceholder: '这台服务器接的是什么，便于以后分辨',
      transport: '连接方式',
      transportHint: '本地命令用 stdio；远程服务用 HTTP（可回退 SSE）',
      command: '命令',
      commandPlaceholder: '如 npx / uvx / node',
      args: '参数',
      argsPlaceholder: '每行一个参数，如：-y',
      argsHint: '每行一个参数，留空表示无参数',
      env: '环境变量',
      envPlaceholder: '如 GITHUB_TOKEN',
      envValuePlaceholder: '值',
      addEnv: '添加环境变量',
      cwd: '工作目录（可选）',
      cwdPlaceholder: '留空则用应用当前目录',
      url: '地址',
      urlPlaceholder: '如 https://example.com/mcp',
      headers: '请求头',
      headerPlaceholder: '如 Authorization',
      headerValuePlaceholder: '值',
      addHeader: '添加请求头',
      timeout: '调用超时（毫秒）',
      timeoutPlaceholder: '留空用默认 60000',
      enabled: '启用',
      enabledHint: '停用后不连接，其工具即刻从工具清单移除',
      tools: '工具',
      toolsAll: '全部启用',
      toolsNone: '全部停用',
      secretsKept: '已保存的值不回显，留空表示不改动'
    },
    transport: {
      stdio: 'stdio（本地命令）',
      http: 'HTTP（远程地址）',
      sse: 'SSE（远程地址）'
    },
    form: {
      createTitle: '新增 MCP 服务器',
      editTitle: '编辑 MCP 服务器：{{name}}',
      toolsCount: '{{total}} 个工具 · 已启用 {{enabled}}',
      test: '测试连接',
      testing: '正在连接…',
      testOk: '连接成功',
      testEmpty: '连接成功，但这台服务器没有暴露工具',
      testFailed: '连接失败'
    },
    messages: {
      saved: '「{{name}}」已保存',
      saveFailedWithReason: '保存失败：{{reason}}',
      loadFailedWithReason: '读取 MCP 服务器失败：{{reason}}',
      importDone: '已导入 {{count}} 台服务器',
      importNone: '没有导入任何服务器',
      importFailedWithReason: '导入失败：{{reason}}',
      importPartial: '部分条目未导入',
      saveHint: '保存后会立即重连这台服务器'
    }
  },

  /* ── workshopSettings（插件工坊：设置 → 插件工坊） ── */
  workshopSettings: {
    pageTitle: '插件工坊',
    pageDescription: '在对话里让助手替你写插件：工坊负责构建、自动验收，通过后装进应用就能用',
    notReady: '工坊当前不可用：请确认 设置 → 插件 里的「AI 助手」处于启用状态',
    actionFailed: '操作失败',
    action: {
      build: '构建',
      verify: '验收',
      publish: '安装并启用',
      update: '更新安装',
      disable: '停用',
      uninstall: '卸载插件',
      export: '导出 zip',
      remove: '删除草稿',
      detail: '详情',
      menu: '更多操作',
      openDir: '打开草稿目录'
    },
    root: {
      title: '插件存放路径',
      pick: '选择文件夹',
      change: '更换文件夹',
      placeholder: '还没有选择插件存放路径',
      rowEmpty: '还没有选择插件存放路径',
      rowDesc: '所有插件都放在这个文件夹下，每个插件一个子目录',
      rowDescEmpty: '插件源码是你自己的东西，放在哪里由你决定——选一个文件夹后就能新建插件了',
      saved: '插件存放路径已设为 {{path}}',
      moved: '插件存放路径已设置，{{count}} 个已有插件也搬了过去'
    },
    list: {
      title: '草稿',
      new: '新建草稿',
      empty: '还没有插件。在助手里说「帮我做一个番茄钟插件」，或用右上角「新建草稿」先生成骨架。',
      needRoot: '先在上面选择插件存放路径，然后就能新建插件了'
    },
    files: '{{count}} 个文件',
    filesSection: '文件（{{count}}）',
    state: {
      enabled: '已启用',
      disabled: '已停用',
      built: '已构建',
      verified: '验收通过',
      verifyFailed: '验收失败 {{failed}}/{{total}}'
    },
    report: {
      title: '验收报告',
      empty: '还没有验收过：点上面的「验收」跑一遍（构建 + 十项检查）',
      hint: '建议：'
    },
    verify: {
      passed: '验收通过（{{count}} 项检查全绿）',
      failed: '验收未通过：{{count}} 项失败'
    },
    build: { ok: '构建完成：{{count}} 个产物文件' },
    publish: { done: '已安装并启用（界面立即生效）' },
    export: { done: '已导出：{{file}}' },
    uninstall: {
      title: '卸载「{{name}}」？',
      body: '卸载会把插件代码从应用里移除（userData 下的插件目录会被删掉）。',
      purge: '同时删除该插件的全部数据（不勾选则数据保留，重装后仍在）'
    },
    remove: {
      title: '删除草稿「{{name}}」？',
      body: '只删除工坊里的源码、构建产物与验收报告；已经装进应用的插件不受影响。'
    },
    template: {
      full: '完整骨架（页面 + 设置页 + AI 工具）',
      page: '独立页面（侧栏菜单 + 路由页面）',
      panel: '设置页（设置 → 助手 下的一页）',
      tool: 'AI 工具（给助手加一个可调用的工具）',
      minimal: '最小骨架'
    },
    create: {
      title: '新建草稿',
      idPlaceholder: '小写 kebab，例如 pomodoro-timer',
      titlePlaceholder: '展示名（例如 番茄钟）',
      note: '生成的是完整骨架：页面、设置页、给助手的 AI 工具、事件推送、卸载清数据都有，用不上的部分交给助手删。'
    }
  }
}
