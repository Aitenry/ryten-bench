import type { zhCNModelSettings } from '../zh-CN/modelSettings'

export const enUSModelSettings: typeof zhCNModelSettings = {
  pageTitle: 'Model providers',
  pageDescription:
    'Manage the model provider configurations used by AI chat and the knowledge graph',
  provider: {
    zhipu: 'Zhipu GLM',
    aliyun: 'Alibaba Cloud Bailian',
    qianfan: 'Baidu Qianfan',
    volcengine: 'Volcano Engine Ark',
    tencent: 'Tencent Hunyuan',
    siliconflow: 'SiliconFlow'
  },
  actions: {
    fetchModels: 'Fetch models',
    addModel: 'Add model',
    batchDelete: 'Delete selected',
    clearSelection: 'Clear selection'
  },
  list: {
    total_one: '<mono>{{count}}</mono> model in total',
    total_other: '<mono>{{count}}</mono> models in total',
    selected_one: '<mono>{{count}}</mono> selected',
    selected_other: '<mono>{{count}}</mono> selected',
    groupCount_one: '<mono>{{count}}</mono> model',
    groupCount_other: '<mono>{{count}}</mono> models',
    pinned: 'Pinned',
    noBaseUrl: '(no URL)',
    alreadyDefault: 'Already the default',
    setDefaultTooltip: 'Set as default',
    setDefaultTitle: 'Set as the default model?',
    setDefaultDescription: 'The chat dialog will select this model by default',
    unfilled: 'Not filled in'
  },
  empty: {
    noModels: 'No models yet. Use the buttons in the top right to add one.'
  },
  modelType: {
    textGeneration: 'Chat',
    imageGeneration: 'Image generation',
    audioGeneration: 'Audio generation',
    videoGeneration: 'Video generation',
    embedding: 'Embedding',
    rerank: 'Rerank',
    other: 'Other'
  },
  capabilityBadge: {
    imageInput: 'Vision',
    functionCalling: 'Tools',
    thinking: 'Thinking',
    streaming: 'Streaming',
    embeddings: 'Embedding'
  },
  thinkingMode: {
    auto: 'Follow the model default',
    on: 'On',
    off: 'Off'
  },
  protocol: {
    customOption: '{{name}} (custom protocol)'
  },
  params: {
    temperaturePlaceholder: 'Leave empty for the best default, or enter a value between 0 and 2',
    topPPlaceholder: 'Leave empty for the best default, or enter a value between 0 and 1',
    topKPlaceholder: 'Leave empty for the best default, or enter a value between 1 and 100'
  },
  form: {
    editTitle: 'Edit model — {{name}}',
    protocol: 'Protocol',
    protocolRequired: 'Please enter a protocol',
    protocolTooltip:
      'Pick a common platform from the list, or type any protocol identifier (such as openai, zhipu, xproxy) and submit it as a custom protocol. Unknown protocols are called in an OpenAI-compatible way. The vendor ID is derived from this field.',
    protocolTooltipEditing:
      'The protocol cannot be changed after creation. To use a different protocol, add a new model.',
    protocolPlaceholder: 'Select or enter a protocol',
    baseUrl: 'API URL',
    baseUrlTooltip:
      'Custom providers must use an OpenAI-compatible or Anthropic-compatible API endpoint',
    apiFormat: 'Compatible protocol',
    apiFormatTooltip:
      'The protocol used to call a custom endpoint: OpenAI-compatible or Anthropic-compatible',
    apiFormatOpenAI: 'OpenAI compatible',
    apiFormatAnthropic: 'Anthropic compatible',
    modelId: 'Model ID',
    modelIdRequired: 'Please enter a model ID',
    modelIdTooltip:
      'Required. The ID is matched against the official models-profile as you type; on a match the context window, output, and capabilities are filled in automatically. Unlisted models fall back to the lowest tiers.',
    modelIdTooltipEditing:
      'The model ID cannot be changed after creation. To use a different model, add a new model.',
    modelIdPlaceholder: 'For example: gpt-4o, deepseek-v4-flash, llama3.1',
    apiKey: 'API Key',
    apiKeyRequired: 'Please enter an API Key',
    apiKeyTooltip: 'The key is encrypted with a private key that is unique to this machine',
    apiKeyTooltipEditing: 'Leave empty to keep the current key',
    apiKeyPlaceholderEditing: 'Leave empty to keep the current key',
    name: 'Name',
    nameTooltip:
      'The name shown in the directory and model pickers. Leave empty to use the model ID. Models covered by the official profile get their official name filled in automatically, and it can be edited.',
    namePlaceholder: 'Leave empty to use the model ID',
    profileMissing:
      'models-profile has no entry for "{{model}}": fill in the context window and output under Advanced settings below, following the official documentation. If you add it with Fetch models instead, unlisted models fall back to a language model with the lowest context window and output tiers.',
    advanced: 'Advanced settings',
    contextWindow: 'Context window (tokens)',
    input: 'Input',
    output: 'Output',
    numberPlaceholder: 'Enter a number, or leave empty for the best default',
    maxToolRounds: 'Tool call rounds',
    maxToolRoundsHint: 'per conversation',
    maxToolRoundsPlaceholder: 'Leave empty for {{value}}',
    imageInput: 'Image input',
    imageInputSupported: 'Supported',
    imageInputUnsupported: 'Not supported',
    thinkingMode: 'Thinking mode',
    thinkingModeHint: 'This protocol does not send the parameter; the value is only stored',
    reasoningEffortLevels: 'Available levels',
    reasoningEffortLevelsPlaceholder: 'Pick or type a level, press Enter',
    samplingParams: 'Sampling parameters',
    enabled: 'Enabled',
    setDefault: 'Set as default',
    setDefaultTooltipNoDefault:
      'There is no default model yet. Turning this on makes the new model the default chat model.',
    pinned: 'Pinned',
    pinnedTooltip:
      'Pinned models come first in the model list. The sort value is set by the database to the current maximum + 1, so there is nothing to fill in.'
  },
  messages: {
    nameSeparator: ', ',
    embeddingNotDefaultChat: 'Embedding models cannot be set as the default chat model',
    vectorNotDefaultChat: 'Embedding models cannot be set as the default chat model',
    updating: 'Updating model...',
    updated: 'Model updated',
    creating: 'Creating model...',
    created: 'Model created',
    settingDefault: 'Setting the default model...',
    defaultUpdated: 'Default model updated',
    setDefaultFailed: 'Failed to set default: {{reason}}',
    fetchFailed: 'Failed to fetch models: {{reason}}',
    selectAtLeastOne: 'Select at least one model',
    invalidProviderId:
      'Enter a valid provider ID: lowercase letters only, digits and hyphens allowed',
    batchAddSuccess_one: 'Added {{count}} model',
    batchAddSuccess_other: 'Added {{count}} models',
    batchAddSuccessWithSkipped_one:
      'Added {{count}} model ({{skipped}} skipped as already present or invalid)',
    batchAddSuccessWithSkipped_other:
      'Added {{count}} models ({{skipped}} skipped as already present or invalid)',
    batchAddFailed: 'Failed to add models: {{reason}}',
    deleteConfirmTitle: 'Delete this model?',
    deleteConfirmContent:
      'Once deleted, "{{name}}" will no longer be available. This action cannot be undone.',
    batchDeleteTitle_one: 'Delete the selected model?',
    batchDeleteTitle_other: 'Delete the {{count}} selected models?',
    batchDeleteDetail: 'Will delete: {{names}}. This action cannot be undone.',
    batchDeleteDetailMore_one:
      'Will delete: {{names}} and others, {{count}} in total. This action cannot be undone.',
    batchDeleteDetailMore_other:
      'Will delete: {{names}} and others, {{count}} in total. This action cannot be undone.',
    batchDeleteSuccess_one: 'Deleted {{count}} model',
    batchDeleteSuccess_other: 'Deleted {{count}} models',
    batchDeleteFailed: 'Failed to delete models: {{reason}}'
  },
  fetch: {
    title: 'Fetch model list',
    addSelected_one: 'Add selected ({{count}})',
    addSelected_other: 'Add selected ({{count}})',
    providerTypePlaceholder: 'Select a provider type',
    customBaseUrlPlaceholder: 'Custom API URL (required)',
    ollamaBaseUrlPlaceholder: 'Ollama API URL',
    customProviderIdPlaceholder: 'Provider ID (required, e.g. my-provider)',
    customProviderIdHint:
      'The provider ID uses lowercase letters only, and may contain digits and hyphens. Listing models only supports OpenAI-compatible endpoints (GET /v1/models).',
    fetchList: 'Fetch model list',
    total_one: '{{count}} model found',
    total_other: '{{count}} models found',
    selectAll: 'Select all',
    deselectAll: 'Deselect all',
    noMetadata: 'No metadata yet (you can fill it in after adding)',
    empty: 'No new models. Existing models are skipped automatically.'
  }
}
