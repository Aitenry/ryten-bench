/* Model settings page entries. */
export const zhCNModelSettings = {
  pageTitle: '大模型供应商',
  pageDescription: '管理 AI 聊天和知识图谱使用的模型供应商配置',
  /* Display names for domestic providers (the other vendors in the preset list already use Latin names, so they are not entries) */
  provider: {
    zhipu: '智谱 GLM',
    aliyun: '阿里云百炼',
    qianfan: '百度千帆',
    volcengine: '火山方舟',
    tencent: '腾讯混元',
    siliconflow: '硅基流动'
  },
  actions: {
    fetchModels: '拉取模型',
    addModel: '添加模型',
    batchDelete: '批量删除',
    clearSelection: '取消选择'
  },
  list: {
    /* <mono> wraps numbers only: monospace fonts lack Chinese glyphs, so Chinese inside it falls back to a serif face */
    total_one: '共 <mono>{{count}}</mono> 个模型',
    total_other: '共 <mono>{{count}}</mono> 个模型',
    selected_one: '已选 <mono>{{count}}</mono> 个',
    selected_other: '已选 <mono>{{count}}</mono> 个',
    groupCount_one: '<mono>{{count}}</mono> 个模型',
    groupCount_other: '<mono>{{count}}</mono> 个模型',
    pinned: '置顶',
    noBaseUrl: '（未填地址）',
    alreadyDefault: '当前已是默认',
    setDefaultTooltip: '设为默认',
    setDefaultTitle: '设为默认模型？',
    setDefaultDescription: '对话框将默认选中该模型进行问答',
    unfilled: '未填写'
  },
  empty: {
    noModels: '暂无模型，点击右上角按钮添加'
  },
  modelType: {
    textGeneration: '对话',
    imageGeneration: '图像生成',
    audioGeneration: '音频生成',
    videoGeneration: '视频生成',
    embedding: '嵌入',
    rerank: '重排',
    other: '其他'
  },
  capabilityBadge: {
    imageInput: '视觉',
    functionCalling: '工具',
    thinking: '思考',
    streaming: '流式',
    embeddings: '嵌入'
  },
  thinkingMode: {
    auto: '跟随模型默认配置',
    on: '开启',
    off: '关闭'
  },
  protocol: {
    customOption: '{{name}}（自定义协议）'
  },
  params: {
    temperaturePlaceholder: '留空使用最佳配置，或输入 0 ~ 2 之间的数值',
    topPPlaceholder: '留空使用最佳配置，或输入 0 ~ 1 之间的数值',
    topKPlaceholder: '留空使用最佳配置，或输入 1 ~ 100 之间的数值'
  },
  form: {
    editTitle: '编辑模型 — {{name}}',
    protocol: '接口协议',
    protocolRequired: '请输入接口协议',
    protocolTooltip:
      '可下拉选择常用平台，也可输入任意协议标识（如 openai、zhipu、xproxy）后从「自定义协议」项提交；未知协议按 OpenAI 兼容方式调用。厂商 ID 由此项推导',
    protocolTooltipEditing: '接口协议创建后不可修改；如需更换协议请新建模型',
    protocolPlaceholder: '选择或输入接口协议',
    baseUrl: 'API 地址',
    baseUrlTooltip: '自定义服务商必须填写 OpenAI 兼容或 Anthropic 兼容的 API 端点',
    apiFormat: '兼容协议',
    apiFormatTooltip: '自定义端点的调用协议：OpenAI 兼容或 Anthropic 兼容',
    apiFormatOpenAI: 'OpenAI 兼容',
    apiFormatAnthropic: 'Anthropic 兼容',
    modelId: '模型ID',
    modelIdRequired: '请输入模型ID',
    modelIdTooltip:
      '必填。输入后自动匹配 models-profile 官方档案，命中即自动补齐上下文窗口、输出与能力（未收录的模型按最低档兜底）',
    modelIdTooltipEditing: '模型 ID 创建后不可修改；如需更换模型请新建一个模型',
    modelIdPlaceholder: '例如：gpt-4o、deepseek-v4-flash、llama3.1',
    apiKey: 'API Key',
    apiKeyRequired: '请输入 API Key',
    apiKeyTooltip: '密钥将使用本机唯一私钥加密存储',
    apiKeyTooltipEditing: '留空则保持原有密钥不变',
    apiKeyPlaceholderEditing: '留空保持原密钥',
    name: '名称',
    nameTooltip:
      '目录与选择器中展示的名称；留空默认使用模型 ID。官方档案收录的模型会自动填入官方名称，可修改',
    namePlaceholder: '留空默认使用模型 ID',
    profileMissing:
      'models-profile 未收录「{{model}}」：可在下方「高级配置」按官方文档填写上下文窗口 / 输出；若改用「拉取模型」添加，未收录的模型会按语言模型 + 最低档上下文窗口 / 输出兜底',
    advanced: '高级配置',
    contextWindow: '上下文窗口（Token）',
    input: '输入',
    output: '输出',
    numberPlaceholder: '请输入数值，留空则使用最佳默认值',
    maxToolRounds: '工具调用轮数',
    maxToolRoundsHint: '次 / 单次对话',
    maxToolRoundsPlaceholder: '留空默认 {{value}}',
    imageInput: '支持图片输入',
    imageInputSupported: '支持',
    imageInputUnsupported: '不支持',
    thinkingMode: '思考模式',
    thinkingModeHint: '当前接口协议不下发该参数，仅记录',
    reasoningEffortLevels: '可选档位',
    reasoningEffortLevelsPlaceholder: '选择或输入档位，回车确认',
    samplingParams: '采样参数',
    enabled: '启用',
    setDefault: '设为默认',
    setDefaultTooltipNoDefault: '当前还没有默认模型，打开后新模型即默认聊天模型',
    pinned: '置顶',
    pinnedTooltip: '置顶后排在模型列表最前；排序值由数据库取当前最大值 +1，无需手填'
  },
  messages: {
    nameSeparator: '、',
    embeddingNotDefaultChat: '嵌入（Embedding）模型不能设为默认聊天模型',
    vectorNotDefaultChat: '向量（Embedding）模型不能设为默认聊天模型',
    updating: '正在更新模型...',
    updated: '模型已更新',
    creating: '正在创建模型...',
    created: '模型已创建',
    settingDefault: '正在设置默认模型...',
    defaultUpdated: '默认模型已更新',
    setDefaultFailed: '设置失败: {{reason}}',
    fetchFailed: '拉取失败: {{reason}}',
    selectAtLeastOne: '请至少选择一个模型',
    invalidProviderId: '请填写有效的供应商 ID：全英文小写，仅可包含数字与 -',
    batchAddSuccess_one: '成功添加 {{count}} 个模型',
    batchAddSuccess_other: '成功添加 {{count}} 个模型',
    batchAddSuccessWithSkipped_one: '成功添加 {{count}} 个模型（跳过 {{skipped}} 个已存在或无效）',
    batchAddSuccessWithSkipped_other:
      '成功添加 {{count}} 个模型（跳过 {{skipped}} 个已存在或无效）',
    batchAddFailed: '批量添加失败: {{reason}}',
    deleteConfirmTitle: '确定删除此模型？',
    deleteConfirmContent: '删除后「{{name}}」将不再可用，此操作不可撤销。',
    batchDeleteTitle_one: '确定删除选中的 {{count}} 个模型？',
    batchDeleteTitle_other: '确定删除选中的 {{count}} 个模型？',
    batchDeleteDetail: '将删除：{{names}}，此操作不可撤销。',
    batchDeleteDetailMore_one: '将删除：{{names}} 等 {{count}} 个，此操作不可撤销。',
    batchDeleteDetailMore_other: '将删除：{{names}} 等 {{count}} 个，此操作不可撤销。',
    batchDeleteSuccess_one: '已删除 {{count}} 个模型',
    batchDeleteSuccess_other: '已删除 {{count}} 个模型',
    batchDeleteFailed: '批量删除失败: {{reason}}'
  },
  fetch: {
    title: '拉取模型列表',
    addSelected_one: '一键添加 ({{count}})',
    addSelected_other: '一键添加 ({{count}})',
    providerTypePlaceholder: '选择供应商类型',
    customBaseUrlPlaceholder: '自定义 API 地址（必填）',
    ollamaBaseUrlPlaceholder: 'Ollama API 地址',
    customProviderIdPlaceholder: '供应商 ID（必填，如 my-provider）',
    customProviderIdHint:
      '供应商 ID 全英文小写，仅可包含数字与 - ｜ 列表拉取仅支持 OpenAI 兼容端点（GET /v1/models）',
    fetchList: '获取模型列表',
    total_one: '共 {{count}} 个模型',
    total_other: '共 {{count}} 个模型',
    selectAll: '全选',
    deselectAll: '不全选',
    noMetadata: '暂无元数据（添加后可编辑填写）',
    empty: '暂无新模型（已存在的模型自动跳过）'
  }
}
