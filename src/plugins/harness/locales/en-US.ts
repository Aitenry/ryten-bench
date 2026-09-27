import type { harnessZhCN } from './zh-CN'

/** `typeof harnessZhCN` 约束：与中文源语言逐键对齐，缺译/多键在编译期即报错 */
export const harnessEnUS: typeof harnessZhCN = {
  /* ── harness（原 locales/en-US/harness.ts） ── */
  /* Harness (assistant) module strings. Keep keys identical to the zh-CN source of truth. */
  harness: {
    index: {
      setupWorkspaceTitle: 'Configure a workspace to start chatting',
      setupWorkspaceDescription:
        'Conversations and memories are isolated per workspace. Pick a directory as your workspace to get started; everything else keeps working.',
      setupWorkspaceButton: 'Choose workspace folder',
      setupModelTitle: 'Configure a model to start chatting',
      setupModelDescription:
        'AI chat needs a model provider. Add and enable at least one model to get started; everything else keeps working.',
      setupModelButton: 'Configure models'
    },
    sidebar: {
      title: 'Workspaces',
      searchPlaceholder: 'Search workspaces and conversations',
      searchDraftPlaceholder: 'Search plugin drafts',
      searchTooltip: 'Search workspaces and conversations',
      exitSearch: 'Exit search',
      assistantSettings: 'Assistant settings',
      newWorkspace: 'New workspace',
      mode: {
        chat: 'Work',
        plugin: 'Plugins',
        chatHint: 'Work mode: workspaces and conversations',
        pluginHint: 'Plugin mode: drafts in the Plugin Workshop (click one to open it)'
      },
      newDraft: 'New plugin draft',
      noDraft: 'No plugin drafts yet. Ask the assistant for one, or create it from the top right.',
      needPluginsPath:
        'Plugin source is yours to keep anywhere - pick a folder to start creating plugins',
      draftActions: 'Draft actions',
      pluginState: {
        draft: 'Draft',
        built: 'Built',
        verified: 'Verified',
        verifyFailed: '{{failed}} check(s) failed',
        enabled: 'In use',
        disabled: 'Disabled'
      },
      noWorkspace: 'No workspace configured yet',
      noMatchResult: 'No matching results',
      noMatchTopic: 'No matching conversations',
      emptyTopics: 'No conversations yet',
      topicDeleteBlocked: 'Running, cannot delete',
      topicDelete: 'Delete conversation',
      topicRunning: 'Conversation is running',
      topicActions: 'Conversation actions',
      workspaceActions: 'Workspace actions',
      workspaceHasRunning: 'A conversation is running',
      workspaceDelete: 'Delete workspace',
      workspaceDeleteConfirmTitle: 'Delete workspace',
      workspaceDeleteConfirmContent:
        'Delete "{{name}}"? All conversations and memories in this workspace will be deleted too.',
      newSession: 'New conversation',
      renameWorkspace: 'Rename workspace',
      workspaceNamePlaceholder: 'Workspace name',
      workspaceNameRequired: 'Please enter a workspace name',
      renameSuccess: 'Workspace renamed',
      renameFailed: 'Failed to rename',
      defaultWorkspaceName: 'Workspace',
      memory: 'Memory',
      memoryNotConfigured:
        'No memory directory configured. The model will have no persistent memory.',
      memoryGoSettings: 'Configure memory in settings',
      memoryUserProfile: 'User profile',
      memoryProject: 'Project memory',
      memoryEmpty: 'No hot memory yet. Tell the model what to remember during a conversation',
      memoryCount: '{{count}}',
      memoryHotEmpty: 'Hot memory -',
      memoryHotCount: '{{count}} hot memories',
      memorySpaces: 'Spaces {{active}}/{{total}} active',
      memoryDocuments: 'Documents {{count}}',
      memoryManage: 'Manage memory',
      timeJustNow: 'Just now',
      timeMinutes: '{{count}}m',
      timeHours: '{{count}}h',
      timeDays: '{{count}}d',
      timeDate: '{{month}}/{{day}}',
      timeFullDate: '{{year}}/{{month}}/{{day}}'
    },
    input: {
      placeholder: 'Send a message to Rita',
      attachTooltip: 'Upload attachment',
      modelPlaceholder: 'Select a model',
      modelLabel: 'Model',
      modelSearchPlaceholder: 'Search models',
      modelEmpty: 'No matching model',
      modelMenuAria: 'Choose model and reasoning effort',
      effortLabel: 'Reasoning effort',
      effortNotSentHint: 'This protocol does not send the parameter; the value is only stored',
      effortSaveFailed: 'Failed to save the reasoning effort',
      back: 'Back',
      stopTooltip: 'Stop generating',
      queueTooltip: 'Sending while generating queues the message',
      visionUnsupported: 'The current model does not support vision, so images cannot be pasted',
      imageReadFailed: 'Failed to read the image attachment: {{name}}',
      filePathUnavailable:
        'Cannot get the local path of "{{name}}". Add it by drag-and-drop or the upload button',
      pasteImageFallbackName: 'paste-image.png',
      permissionAria: 'Choose the permission mode',
      permissionLabel: 'Permission'
    },
    permission: {
      readOnly: 'Read only',
      workspaceWrite: 'Workspace write',
      fullAccess: 'Full access',
      readOnlyHint: 'Reads only: writes and risky commands are blocked; the model may ask once',
      fullAccessHint: 'No interception: file changes and commands run directly',
      confirmTitle: 'Enable full access?',
      confirmBody:
        'With full access the agent skips confirmation steps and can act directly, including sensitive operations, file changes and external commands. Only use it when you trust the tasks ahead.',
      confirmOk: 'Enable full access',
      confirmCancel: 'Cancel',
      defaultLabel: 'Default permission mode',
      defaultHint:
        'Applies to conversations created from now on; the current one can be switched in the composer',
      switchFailed: 'Failed to switch the permission mode'
    },
    sandbox: {
      label: 'Sandbox',
      full: 'full enforcement',
      partial: 'partial enforcement',
      unavailable: 'unavailable',
      fullHint:
        'Write restrictions are enforced by the operating system: everything outside the workspace is denied',
      partialHint:
        'Write restrictions are enforced by the operating system; the restricted token keeps Everyone and NTFS hard links can alias files, so enforcement is partial (known boundary)',
      unavailableHint:
        'No kernel-level isolation is available on this platform, so commands are refused instead of running unconfined: {{reason}}',
      backendWindows: 'Windows restricted token + ACL',
      backendBwrap: 'Linux bubblewrap',
      backendLandlock: 'Linux Landlock',
      backendSeatbelt: 'macOS Seatbelt'
    },
    approval: {
      title: 'Your approval is required',
      toolLabel: 'Tool',
      detailLabel: 'Operation',
      allowOnce: 'Allow once',
      deny: 'Deny',
      escalationNote: 'The model asks to escalate to "{{mode}}" for one call: {{justification}}',
      footerHint:
        'This allows the call once; the same operation will ask again. Use "Stop" to end the turn.'
    },
    queue: {
      count: '{{count}} queued message(s)',
      hint: 'Messages sent while generating wait here',
      heldHint: 'Not injected in time — will be sent with your next message',
      steered: 'Interjected',
      edit: 'Edit',
      save: 'Save',
      cancelEdit: 'Cancel',
      remove: 'Remove',
      editFailed: 'Failed to edit the queued message',
      steer: 'Interject now (merge into this turn)',
      steerUnavailable: 'No running turn — this message will be sent as the next turn',
      attachmentCount: '[{{count}} attachment(s)] '
    },
    header: {
      toggleSidebar: 'Sidebar',
      togglePanel: 'Workspace panel'
    },
    messageArea: {
      scrollToBottom: 'Back to bottom',
      showEarlier: 'Show {{count}} earlier messages'
    },
    messageLocator: {
      jumpToRound: 'Jump to turn {{round}}',
      emptyMessage: '(empty message)',
      noAnswer: '(no answer yet)',
      codePlaceholder: ' [code] ',
      imagePlaceholder: ' [image] '
    },
    welcome: {
      title: "Hi, I'm Rita~",
      subtitleWeather:
        "How's the weather today? If it looks good, I can plan tomorrow's schedule for you too~",
      subtitleDocument:
        'I can analyze your documents, pull out the key information, and map how they relate.',
      subtitleTodo:
        'Tell me anything important and I will keep track of it and turn it into to-dos.',
      subtitleKnowledge: 'I can organize scattered documents into a knowledge base for you.'
    },
    loading: {
      generating: 'Generating...'
    },
    assistantMessage: {
      toolCallFallback: 'Tool call',
      toolPreparing: 'Building arguments…',
      toolExecuting: 'Running…',
      thinkingInProgress: 'Thinking…',
      thinkingDone: 'Thinking process',
      foldExpand: 'Show all',
      foldCollapse: 'Collapse',
      retrying: 'Retrying (attempt {{attempt}}/{{retries}})…',
      compacting: 'Compacting earlier conversation…',
      compacted: 'Earlier conversation compacted',
      compactedCounts: '<mono>{{compressed}}</mono> → kept <mono>{{retained}}</mono>',
      memoryInjected: 'Injected memory · <mono>{{count}}</mono>',
      memoryInjectedUser:
        '(user profile <mono>{{user}}</mono> · project memory <mono>{{memory}}</mono>)',
      memoryInjectedProject: '(project memory <mono>{{count}}</mono>)',
      userProfileBytes: 'User profile USER (<mono>{{bytes}}</mono> bytes)',
      projectMemoryBytes: 'Project memory MEMORY (<mono>{{bytes}}</mono> bytes)',
      toolInput: 'Input:',
      toolOutput: 'Output:',
      toolOutputHidden: '{{hidden}} characters not shown',
      longTextTail: 'Long message — showing the end only ({{hidden}} characters hidden)',
      toolOutputTotal: '{{total}} characters in total',
      toolOutputExpand: 'Show all',
      toolOutputCollapse: 'Collapse',
      dispatched: 'Background task dispatched',
      subAgentRunning: '{{name}} · Running…',
      subAgentError: '{{name}} · Error',
      subAgentCompleted: '{{name}} · Completed',
      subAgentExecuting: 'The agent is working…',
      silentGenerating: 'Generating…',
      taskList: 'Task list',
      /** 段头上的改动徽标 / changed-files badge on a task segment header */
      changedFiles: '{{count}} file(s) changed',
      changedFilesTip:
        '{{files}} file(s) changed in this step · {{pending}} awaiting review (click to diff)',
      toolOpenFile: 'Open file',
      toolRevealDir: 'Reveal in explorer',
      toolViewDetail: 'View result details',
      toolFailed: 'Failed',
      toolTruncated: ' · truncated',
      toolLines: '{{count}} lines',
      toolLines_one: '{{count}} line',
      toolLines_other: '{{count}} lines',
      toolLineRange: '{{start}}-{{end}} of {{total}} lines',
      toolFileCount: '{{count}} files',
      toolFileCount_one: '{{count}} file',
      toolFileCount_other: '{{count}} files',
      toolExitCode: 'exit {{code}}',
      toolReplacements: '<mono>{{count}}</mono> replacements',
      toolReplacements_one: '<mono>{{count}}</mono> replacement',
      toolReplacements_other: '<mono>{{count}}</mono> replacements',
      itemCount: '<mono>{{count}}</mono> items',
      itemCount_one: '<mono>{{count}}</mono> item',
      itemCount_other: '<mono>{{count}}</mono> items',
      matchCount: '<mono>{{count}}</mono> matches',
      matchCount_one: '<mono>{{count}}</mono> match',
      matchCount_other: '<mono>{{count}}</mono> matches',
      memoryTool: 'Memory tool',
      memoryWrite: 'Memory write',
      memoryStatus: 'Memory status',
      memorySpaces: 'Memory spaces',
      memoryRecall: 'Memory recall',
      memoryDocumentSearch: 'Document search',
      memoryRelated: 'Related memories',
      memoryBodyActivate: '{{active}}/{{total}} active',
      memoryBodyHot: 'Hot memory',
      memoryBodyDocuments: 'Project documents',
      memoryBodySpaceFallback: 'Space {{index}}',
      memoryBodyUnnamed: 'Unnamed space',
      memoryBodyActive: 'Active',
      memoryBodyInactive: 'Inactive',
      memoryBodyInsights: '<mono>{{count}}</mono> insights',
      memoryBodyInsights_one: '<mono>{{count}}</mono> insight',
      memoryBodyInsights_other: '<mono>{{count}}</mono> insights',
      memoryBodyTotalActive: '<mono>{{total}}</mono> total · <mono>{{active}}</mono> active',
      statusParseFailed: 'Cannot parse the status output',
      toolOutputParseFailed: 'Cannot parse the tool output',
      memoryBodyEmpty: 'No memory spaces yet. Ask the model to create one in a conversation',
      memoryBodyCount: '<mono>{{count}}</mono> items',
      memoryBodyCount_one: '<mono>{{count}}</mono> item',
      memoryBodyCount_other: '<mono>{{count}}</mono> items',
      memoryDocumentCount: '<mono>{{count}}</mono> documents',
      memoryDocumentCount_one: '<mono>{{count}}</mono> document',
      memoryDocumentCount_other: '<mono>{{count}}</mono> documents',
      memoryDocumentActive: 'Active',
      memoryDocumentArchived: 'Archived',
      memoryRecallEmpty: 'No related memories recalled',
      memoryDocumentEmpty: 'No matching documents found',
      memoryRelatedEmpty: 'No related memories found',
      memoryEntrySource: 'Source: {{name}}',
      memoryEntryScore: 'Relevance {{score}}',
      memoryEntryDepth: 'Depth {{depth}}',
      memoryRemembered: 'Saved to "{{name}}"',
      memoryCategory: 'Category: {{category}}',
      memoryImportance: 'Importance {{importance}}'
    },
    messageActions: {
      copied: 'Copied',
      copy: 'Copy',
      feedbackUp: 'Good answer',
      feedbackUpMarked: 'Marked: good answer',
      feedbackDown: 'Bad answer',
      feedbackDownMarked: 'Marked: bad answer',
      feedbackUpRecorded: 'Recorded: good answer',
      feedbackDownRecorded: 'Recorded: bad answer',
      feedbackCanceled: 'Feedback cleared',
      saveToMemory: 'Save to memory',
      savingToMemory: 'Handing off to the memory agent…',
      saveToMemoryEmpty: 'This answer has no body text to save',
      saveToMemoryNoTopic: 'No conversation to curate memory for',
      saveToMemoryDisabled: 'No memory directory is configured yet, so nothing can be stored',
      saveToMemoryNoModel: 'No model available — pick a default model in settings first',
      saveToMemoryStarted: 'Handed to the memory agent — watch its progress in the top bar',
      saveToMemoryFailed: 'Failed to save to memory',
      branch: 'Branch into a new conversation',
      branching: 'Creating branch…',
      deleteTurn: 'Delete this exchange',
      deleteConfirmTitle: 'Confirm deletion',
      deleteConfirmContent: 'This exchange will be deleted and cannot be recovered afterwards.',
      elapsedTooltip: 'Time from asking to the answer finishing',
      elapsed: 'Took {{elapsed}}',
      elapsedSeconds: '{{seconds}}s',
      elapsedMinutes: '{{minutes}}m {{seconds}}s'
    },
    usagePanel: {
      title: 'Usage for this turn',
      route: 'Provider / model',
      cacheHit: 'Cache hit',
      uncachedInput: 'Uncached input',
      cacheRead: 'Cache read',
      cacheWrite: 'Cache write',
      input: 'Input',
      output: 'Output',
      reasoning: 'of which reasoning',
      calls: 'Model calls',
      callsValue: '{{count}} calls',
      tokensValue: '{{value}} tok'
    },
    goalBar: {
      phaseActive: 'Active',
      phasePaused: 'Paused',
      phaseBlocked: 'Blocked',
      phaseComplete: 'Complete',
      blocked: 'Blocked ({{code}}): {{message}}',
      round: 'Round {{current}}/{{max}}'
    },
    taskCard: {
      completed: '{{done}}/{{total}} completed',
      inProgress: '· {{count}} in progress'
    },
    userMessage: {
      goalRound: 'Goal auto-continuation · round {{round}}',
      goalPrev: 'Previous round',
      goalNext: 'Next round',
      noReply: 'No reply',
      edit: 'Edit this prompt (in place, Enter to resend)',
      editHint: 'Enter to send · Shift+Enter for newline · Esc to cancel',
      deleteOrphan: 'Delete this prompt',
      deleteOrphanTitle: 'Delete this prompt?',
      deleteOrphanContent: 'This prompt has no reply yet. Deleting it cannot be undone.'
    },
    askQuestion: {
      title: 'Your confirmation is needed',
      okText: 'Submit answer',
      customPlaceholder: 'Type your answer…',
      footerHint:
        'After submitting, the model continues in this turn; click "Stop generating" to cancel the question and abort the turn.'
    },
    modelRecovery: {
      title: 'Model request failed',
      abandon: 'Abandon this turn',
      continueWithModel: 'Continue with selected model',
      searchPlaceholder: 'Search model name',
      noMatch: 'No model matches "{{query}}"',
      noModels: 'No models available. Add and enable one in Settings → Models, then try again.',
      hint: 'After switching, execution resumes from the interruption point with the new model. The question is not resent and completed tools are not re-run.'
    },
    backgroundAgents: {
      running: 'Running',
      failed: 'Failed',
      killed: 'Stopped',
      completed: 'Completed',
      runningCount: '{{count}} running',
      completedCount: '{{count}} completed',
      failedCount: '{{count}} failed',
      killedCount: '{{count}} stopped',
      summarySeparator: ', ',
      promptLabel: 'Task',
      generating: 'Generating…',
      noOutput: 'No output yet'
    },
    fileExplorer: {
      title: 'Resource editor',
      refresh: 'Refresh',
      loading: 'Loading...',
      empty: 'Empty folder',
      openFailed: 'Failed to open the file',
      saveFailed: 'Failed to save the file',
      pendingReview: '{{count}} to review',
      /** 改动记录条数不是文件数（同一个文件改 10 次 = 10 条），所以标题栏的主口径是文件数 */
      pendingFiles: '{{count}} file',
      pendingSummary: '{{files}} · {{changes}}',
      pendingFilesTip: 'Files with unreviewed model changes',
      keepAllTip: 'Keep all: clear the review flags without touching the files on disk'
    },
    fileEditor: {
      loading: 'Loading editor...',
      modeEdit: 'Edit',
      modeDiff: 'Diff',
      wrapTip: 'Toggle word wrap',
      reloadTip: 'Reload from disk (discard unsaved edits)',
      diskChanged: 'Disk changed',
      diskChangedTip:
        'This file changed on disk while you had unsaved edits. Saving keeps your version; reload to take the disk version.',
      caret: 'Ln {{line}}, Col {{column}}',
      selected: '{{count}} selected',
      lines: '{{count}} lines',
      readOnly: 'Read-only',
      modified: 'Unsaved',
      saved: 'Saved',
      pendingReview: '{{count}} change(s) to review',
      mdRich: 'Rich text',
      mdRichTip: 'What-you-see-is-what-you-get editing',
      mdSource: 'Source',
      mdSourceTip: 'Edit the Markdown source',
      mdPlaceholder: 'Start writing…',
      chars: '{{count}} chars'
    },
    fileDiff: {
      stats: '{{count}} change(s) · +{{added}} −{{removed}}',
      acceptChunk: 'Keep',
      rejectChunk: 'Revert',
      acceptChunkTip: 'Keep this change (merge the model version into the file)',
      rejectChunkTip: 'Revert this change (restore the text before the edit)',
      keepAll: 'Keep all',
      keepAllTip: 'Keep every pending change; the file on disk stays as the model wrote it',
      keepMixedTip: 'Keep all: your per-hunk choices are written to disk and marked as reviewed',
      revertAll: 'Revert all',
      revertAllTip: 'Restore the file to its content before the earliest pending change',
      keepOne: 'Keep',
      revertToHere: 'Revert to here',
      history: 'History ({{count}})',
      historyTitle: 'Change history',
      historyEmpty: 'No recorded changes for this file',
      prevChunk: 'Previous change',
      nextChunk: 'Next change',
      unsaved: 'Unsaved',
      noSnapshot:
        'No before-image for this change (produced by a command or an external edit), so it cannot be reverted.',
      historicalHint: 'Viewing an earlier change — review actions apply to the newest one.',
      revertFailed: 'Failed to revert the change',
      applyFailed: 'Failed to apply the reviewed content',
      sourceWrite: 'write_file',
      sourceEdit: 'edit_file',
      sourceExecute: 'Command',
      sourceExternal: 'External',
      sourceReview: 'Reviewed',
      statusPending: 'Pending review',
      statusKept: 'Kept',
      statusReverted: 'Reverted',
      statusObsolete: 'Superseded'
    },
    toolDetail: {
      unavailable: 'Result details unavailable (may have been cleaned up with the topic)',
      emptyOutput: '(no output)',
      emptyResult: '(no results)',
      exitCode: 'exit {{code}}',
      outputFooter:
        'Full command output; anything beyond the output limit was truncated when produced.'
    },
    helpers: {
      toolPreparing: '{{name}} · Building arguments…',
      toolExecuting: '{{name}} · Running…'
    },
    handlers: {
      branchCreating: 'Creating branch conversation...',
      branchUntitled: 'Untitled',
      branchTitle: 'Branch · {{title}}',
      branchSuccess: 'Branched into a new conversation ({{count}} messages)',
      branchListHint: 'Branch conversation created. Open it from the list on the left',
      branchFailed: 'Failed to branch',
      sendFailed: 'Sorry, something went wrong. Please try again later.'
    }
  },
  /* ── agentSettings（原 locales/en-US/agentSettings.ts） ── */
  /* Agent settings page strings. Keep keys identical to the zh-CN source of truth. */
  agentSettings: {
    pageTitle: 'Agents',
    pageDescription: 'Configure main agent defaults, plus the subagents it can delegate tasks to',
    sections: {
      mainAgent: 'Main agent',
      subagents: 'Subagents'
    },
    main: {
      defaultTools: 'Default tools',
      defaultToolsDescription:
        'System tools available to the main agent. Each MCP server is picked as one group (named after the server); which tools it contains is toggled on the MCP settings page',
      defaultToolsPlaceholder: 'Select tools',
      mcpToolsCount: '{{enabled}}/{{total}} enabled',
      defaultSkills: 'Default skills',
      defaultSkillsDescription: 'Choose the skills available to the main agent',
      defaultSkillsPlaceholder: 'Select skills (none if left empty)',
      saved: 'Main agent saved'
    },
    list: {
      description_one: '{{count}} total. Only enabled agents take effect in conversations',
      description_other: '{{count}} total. Only enabled agents take effect in conversations',
      newAgent: 'New',
      toolCount_one: '{{count}} tool',
      toolCount_other: '{{count}} tools',
      skillCount_one: '{{count}} skill',
      skillCount_other: '{{count}} skills'
    },
    form: {
      createTitle: 'New agent',
      editTitle: 'Edit agent: {{name}}',
      chineseName: 'Chinese name',
      chineseNamePlaceholder: 'e.g. 研究代理 (optional)',
      identifier: 'English identifier',
      identifierPlaceholder: 'e.g. research-agent',
      identifierRequired: 'Please enter an English identifier',
      identifierPattern: 'Use lowercase letters, numbers, and hyphens only',
      enabled: 'Enabled',
      description: 'Description',
      descriptionPlaceholder:
        'Describe what the agent does. The main agent uses this to decide when to delegate tasks',
      descriptionRequired: 'Please enter a description',
      systemPrompt: 'System prompt',
      systemPromptPlaceholder: 'The agent role and behavior guidelines',
      systemPromptRequired: 'Please enter a system prompt',
      tools: 'Available tools',
      toolsPlaceholder: 'Select the system tools available to the agent (none if left empty)',
      model: 'Model (optional)',
      modelTooltip:
        'Overrides the main agent model. Leave empty to use the main agent model. ' +
        'Only non-Embedding models are listed',
      modelPlaceholder: 'Use the main agent default model',
      skills: 'Skills (optional)',
      skillsTooltip: 'Choose the skills available to the agent from the loaded skill directories',
      skillsPlaceholder: 'Select the skills available to the agent (none if left empty)',
      skillsNotConfigured: 'No skills found. Configure a directory in Skills settings first',
      skillsNoMatch: 'No matching skills'
    },
    messages: {
      agentUpdated: 'Agent updated',
      agentCreated: 'Agent created',
      opened: 'Enabled',
      closed: 'Disabled',
      toggleFailedWithReason: 'Failed to toggle: {{reason}}',
      deleted: 'Deleted',
      deleteConfirmTitle: 'Delete agent "{{name}}"?',
      importEmptyFile: 'The file is empty',
      importInvalidJson: 'Invalid JSON. Please check the file',
      importNotArray: 'JSON content must be an array',
      importEmptyContent: 'Nothing to import',
      importFailedWithReason: 'Import failed: {{reason}}',
      importStrippedSkippedName: '(missing name)',
      importMissingTool: '{{name}}: tool [{{items}}] not found, removed',
      importMissingSkill: '{{name}}: skill [{{items}}] not found, removed',
      importMissingModel: '{{name}}: model "{{model}}" not found, removed',
      importSummaryImported_one: 'Imported {{count}} agent',
      importSummaryImported_other: 'Imported {{count}} agents',
      importSummarySkipped_one: '{{count}} skipped',
      importSummarySkipped_other: '{{count}} skipped',
      importSummaryNone: 'No agents imported',
      importSummarySeparator: ', ',
      importStrippedTitle: 'The following entries were removed because they no longer exist',
      readFileFailed: 'Failed to read the file'
    },
    empty: {
      noAgents: 'No agents yet. Click New in the top right to create one'
    }
  },
  /* ── memorySettings（原 locales/en-US/memorySettings.ts） ── */
  memorySettings: {
    page: {
      title: 'Memory (Mnemon)',
      description:
        'Three layers of memory: runtime memory (injected every turn), long-term memory spaces (recalled on demand), and project documents (full archives). Stored under the memory root directory and isolated per workspace, so each workspace keeps its own memory.'
    },
    storage: {
      sectionTitle: 'Memory storage directory',
      placeholder: 'For example: E:\\RytenBench\\Memory (leave empty to disable)',
      browse: 'Browse...',
      activePath: 'Currently in use: {{path}}',
      saved: 'Memory directory saved',
      cleared: 'Memory directory cleared',
      selectFailed: 'Failed to select directory: {{reason}}'
    },
    enable: {
      sectionTitle: 'Enable memory',
      empty: 'No memory directory is configured, so the model has no persistent memory.',
      emptyHint:
        'Pick a directory above (for example E:\\RytenBench\\Memory) and save to enable the three memory layers.'
    },
    manage: {
      sectionTitle: 'Memory management',
      snapshotFailed: 'Failed to load memory snapshot: {{reason}}'
    },
    tabs: {
      runtime: 'Runtime ({{count}})',
      bodies: 'Memory spaces ({{count}})',
      documents: 'Documents ({{count}})'
    },
    importance: {
      label: 'Importance',
      critical: 'High',
      normal: 'Normal',
      low: 'Low'
    },
    runtime: {
      bytes: '{{used}} / {{limit}} bytes',
      count: '{{count}} entries',
      add: 'Remember',
      emptyUser: 'No user profile memory yet',
      emptyMemory: 'No project memory yet',
      removeConfirm: 'Delete this memory entry?',
      contentRequired: 'Please enter the memory content'
    },
    targets: {
      userLabel: 'User profile',
      userDesc: 'Identity · Preferences · Communication style',
      userPlaceholder:
        'Enter what to remember about the user, e.g. prefers the dark theme, likes editorial-style design',
      userHint:
        'The user profile holds 4 KiB; high-importance entries are kept first when it is compacted.',
      memoryLabel: 'Project memory',
      memoryDesc: 'Decisions · Conventions · Reusable lessons',
      memoryPlaceholder:
        'Enter what to remember about the project, e.g. the refactor plan is final and uses LangChain underneath',
      memoryHint:
        'Project memory holds 10 KiB; once full, low-priority entries are archived to a memory space automatically.'
    },
    bodies: {
      namePlaceholder: 'Space name, e.g. Blog project',
      descriptionPlaceholder:
        'Routing description: what belongs here and when it should be recalled',
      create: 'Create space',
      nameRequired: 'Please enter a space name',
      created: 'Created "{{name}}"',
      empty:
        'No memory spaces yet. The model can create one with the mnemon_memory_body_create tool during a conversation, or you can create one here.',
      active: 'Active',
      inactive: 'Inactive',
      unhealthy: 'Unhealthy',
      stats: 'Insights {{insights}} · Relations {{edges}} · Deleted {{deleted}}',
      content: 'Content',
      participatesInRecall: 'Included in recall',
      excludedFromRecall: 'Excluded from recall'
    },
    insights: {
      title: 'Content of "{{name}}"',
      empty: 'No content in this space yet',
      meta: '{{category}} · Importance {{importance}} · {{date}}'
    },
    documents: {
      empty:
        'No project documents yet. The model can create design, process, or handover documents with the mnemon_document_manage tool during a conversation.',
      updatedAt: 'Updated {{time}} · revision {{revision}}'
    },
    mechanism: {
      sectionTitle: 'How memory works',
      runtimeTitle: 'Runtime memory',
      runtimeDesc:
        'USER profile (4 KiB) + MEMORY project memory (10 KiB), injected automatically every turn; the model maintains it with the mnemon_runtime_memory tool; when MEMORY is full, entries are archived to a memory space automatically.',
      bodiesTitle: 'Long-term memory spaces',
      bodiesDesc:
        'Insights that stay stable across sessions, each space with its own database and four relation types; mnemon_recall retrieves and mnemon_remember stores; the active state controls whether a space takes part in recall.',
      documentsTitle: 'Project documents',
      documentsDesc:
        'Full Markdown documents (design, process, handover); active takes part in search while archived stays cold; mnemon_document_manage creates and mnemon_document_search searches.'
    }
  },
  /* ── skillsSettings（原 locales/en-US/skillsSettings.ts） ── */
  skillsSettings: {
    pageTitle: 'Skills',
    pageDescription:
      'Configure the global Skills storage directory. Each subfolder is loaded as a separate Skill, and you can enable or disable Skills individually. Leave it empty to disable Skills.',
    dirSectionTitle: 'Skills storage directory',
    dirSectionDescription: 'Every subdirectory containing a SKILL.md file counts as one Skill',
    dirPlaceholder: 'e.g. D:\\skills (leave empty to disable)',
    dirCurrent: 'Currently active: {{path}}',
    listTitle: 'Discovered skills ({{count}})',
    listTitle_one: 'Discovered skill ({{count}})',
    listTitle_other: 'Discovered skills ({{count}})',
    emptyDescription:
      'No Skills found in this directory. Make sure each subdirectory contains a {{filename}} file.',
    savedDir: 'Skills directory saved',
    clearedDir: 'Skills directory cleared'
  },
  /* ── mcpSettings (Settings → MCP) ── */
  mcpSettings: {
    pageTitle: 'MCP',
    pageDescription:
      'Connect external MCP servers (a local stdio process or a remote HTTP/SSE endpoint). The tools a server exposes show up in the agent tool list. Statuses come from the last connection attempt — use "Reconnect" to refresh.',
    list: {
      sectionTitle: 'Servers',
      newServer: 'Add',
      importFile: 'Import config',
      reconnect: 'Reconnect',
      reconnectDone: 'Reconnected {{count}} server(s)',
      empty: 'No MCP servers yet — use "Add" or "Import config" in the top right',
      toolCount: '{{count}} tools',
      toolCount_one: '{{count}} tool',
      toolCount_other: '{{count}} tools',
      toolsEnabledCount: '{{total}} tools · {{enabled}} enabled',
      edit: 'Edit',
      remove: 'Delete',
      removeConfirmTitle: 'Delete MCP server "{{name}}"?',
      removeConfirmBody:
        'This only removes the local configuration entry; the server itself is untouched. This cannot be undone.',
      removed: '"{{name}}" deleted',
      enableFailedWithReason: 'Could not toggle the server: {{reason}}',
      connectFailed: 'Connection failed'
    },
    status: {
      ok: 'Connected',
      error: 'Connection failed',
      disabled: 'Disabled',
      unconfigured: 'Incomplete config',
      unknown: 'Not connected'
    },
    field: {
      name: 'Name',
      namePlaceholder: 'e.g. filesystem / github / postgres',
      nameHint: 'Used as the tool name prefix; latin letters and dashes work best',
      description: 'Description (optional)',
      descriptionPlaceholder: 'What this server provides, so it stays identifiable',
      transport: 'Transport',
      transportHint: 'Use stdio for local commands, HTTP (SSE fallback) for remote endpoints',
      command: 'Command',
      commandPlaceholder: 'e.g. npx / uvx / node',
      args: 'Arguments',
      argsPlaceholder: 'One argument per line, e.g. -y',
      argsHint: 'One argument per line; leave empty for none',
      env: 'Environment variables',
      envPlaceholder: 'e.g. GITHUB_TOKEN',
      envValuePlaceholder: 'value',
      addEnv: 'Add variable',
      cwd: 'Working directory (optional)',
      cwdPlaceholder: 'Defaults to the app working directory',
      url: 'URL',
      urlPlaceholder: 'e.g. https://example.com/mcp',
      headers: 'Headers',
      headerPlaceholder: 'e.g. Authorization',
      headerValuePlaceholder: 'value',
      addHeader: 'Add header',
      timeout: 'Call timeout (ms)',
      timeoutPlaceholder: 'Empty uses the default 60000',
      enabled: 'Enabled',
      enabledHint: 'When disabled the server is not connected and its tools disappear',
      tools: 'Tools',
      toolsAll: 'Enable all',
      toolsNone: 'Disable all',
      secretsKept: 'Stored values are not echoed back; leave empty to keep them'
    },
    transport: {
      stdio: 'stdio (local command)',
      http: 'HTTP (remote endpoint)',
      sse: 'SSE (remote endpoint)'
    },
    form: {
      createTitle: 'Add MCP server',
      editTitle: 'Edit MCP server: {{name}}',
      toolsCount: '{{total}} tools · {{enabled}} enabled',
      test: 'Test connection',
      testing: 'Connecting…',
      testOk: 'Connected',
      testEmpty: 'Connected, but this server exposes no tools',
      testFailed: 'Connection failed'
    },
    messages: {
      saved: '"{{name}}" saved',
      saveFailedWithReason: 'Save failed: {{reason}}',
      loadFailedWithReason: 'Could not load MCP servers: {{reason}}',
      importDone: 'Imported {{count}} server(s)',
      importNone: 'No servers were imported',
      importFailedWithReason: 'Import failed: {{reason}}',
      importPartial: 'Some entries were not imported',
      saveHint: 'Saving reconnects this server right away'
    }
  },

  /* ── workshopSettings (Plugin Workshop settings page) ── */
  workshopSettings: {
    pageTitle: 'Plugin Workshop',
    pageDescription:
      'Let the assistant write a plugin in chat; the workshop builds it, runs automated acceptance checks, and installs it once it passes',
    notReady:
      'The workshop is unavailable: make sure the "AI assistant" plugin is enabled in Settings → Plugins',
    actionFailed: 'Action failed',
    action: {
      build: 'Build',
      verify: 'Verify',
      publish: 'Install & enable',
      update: 'Update install',
      disable: 'Disable',
      uninstall: 'Uninstall plugin',
      export: 'Export zip',
      remove: 'Delete draft',
      detail: 'Details',
      menu: 'More actions',
      openDir: 'Open draft folder'
    },
    root: {
      title: 'Plugins folder',
      pick: 'Choose folder',
      change: 'Change folder',
      placeholder: 'No plugins folder chosen yet',
      rowEmpty: 'No plugins folder chosen yet',
      rowDesc: 'Every plugin lives in this folder, one subfolder each',
      rowDescEmpty:
        'Plugin source is yours, so you decide where it goes - pick a folder and you can create plugins',
      saved: 'Plugins folder set to {{path}}',
      moved: 'Plugins folder set; {{count}} existing plugin(s) were moved there too'
    },
    list: {
      title: 'Drafts',
      new: 'New draft',
      empty:
        'No plugins yet. Ask the assistant for one ("build me a pomodoro plugin"), or use "New draft" to scaffold a skeleton.',
      needRoot:
        'No plugins folder picked yet. Plugin source lives wherever you want - pick a folder to start creating plugins'
    },
    files: '{{count}} file(s)',
    filesSection: 'Files ({{count}})',
    state: {
      enabled: 'Enabled',
      disabled: 'Disabled',
      built: 'Built',
      verified: 'Verified',
      verifyFailed: 'Verification failed {{failed}}/{{total}}'
    },
    report: {
      title: 'Acceptance report',
      empty: 'Not verified yet: hit "Verify" to build and run the acceptance battery',
      hint: 'Suggestion: '
    },
    verify: {
      passed: 'Verified: all {{count}} checks passed',
      failed: 'Verification failed: {{count}} check(s) failed'
    },
    build: { ok: 'Build finished: {{count}} artifact file(s)' },
    publish: { done: 'Installed and enabled (effective immediately)' },
    export: { done: 'Exported: {{file}}' },
    uninstall: {
      title: 'Uninstall "{{name}}"?',
      body: 'Uninstalling removes the plugin code from the app (its folder under userData is deleted).',
      purge: 'Also delete all of this plugin’s data (leave unchecked to keep the data)'
    },
    remove: {
      title: 'Delete draft "{{name}}"?',
      body: 'This only deletes the workshop source, build output and report; an already installed plugin is unaffected.'
    },
    template: {
      full: 'Full skeleton (page + settings + AI tool)',
      page: 'Standalone page (sidebar menu + route)',
      panel: 'Settings page (a page under Settings → Assistant)',
      tool: 'AI tool (a tool the assistant can call)',
      minimal: 'Minimal skeleton'
    },
    create: {
      title: 'New draft',
      idPlaceholder: 'lowercase kebab, e.g. pomodoro-timer',
      titlePlaceholder: 'Display name (e.g. Pomodoro)',
      needRoot: 'No plugins folder picked yet - pick one first, then create the draft',
      note: 'The draft comes with everything: page, settings page, an AI tool for the assistant, event push and data purge. Let the assistant delete what you do not need.'
    }
  }
}
