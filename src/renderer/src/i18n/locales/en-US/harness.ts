import type { harnessZhCN } from '../zh-CN/harness'

/** The `typeof harnessZhCN` constraint: keys line up one-to-one with the Chinese source, so a missing or extra key fails at compile time */
export const harnessEnUS: typeof harnessZhCN = {
  /* ── harness ── */
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
      searchTopicPlaceholder: 'Search conversations',
      searchTooltip: 'Search workspaces and conversations',
      exitSearch: 'Exit search',
      newWorkspace: 'New workspace',
      mode: {
        work: 'Work',
        chat: 'Chat',
        plugin: 'Plugins',
        workHint: 'Work mode: workspaces and conversations',
        chatHint: 'Chat mode: talk directly, no workspace (just one conversation list)',
        pluginHint:
          'Plugin mode: drafts in the Plugin Workshop (click a row = new conversation for it; open details from ⋯)'
      },
      newDraft: 'New plugin draft',
      pluginActions: 'Plugin actions',
      pluginRename: 'Rename plugin',
      pluginNamePlaceholder: 'Plugin name',
      pluginNameRequired: 'Plugin name cannot be empty',
      pluginRenameNote:
        'Display name only; the plugin id (folder and channel namespace) stays {{id}}',
      pluginDelete: 'Delete plugin',
      pluginDeleteTitle: 'Delete plugin "{{name}}"?',
      pluginNewSession: 'New conversation about this plugin',
      /** Disclosure next to the plugin row title: expands this plugin's own conversations */
      pluginSessionsExpand: "Show this plugin's conversations",
      pluginSessionsCollapse: "Hide this plugin's conversations",
      needWorkspace: 'Set up a workspace first - conversations live under it',
      noDraft: 'No plugin drafts yet. Ask the assistant for one, or create it from the top right.',
      needPluginsPath: 'No plugins folder yet',
      pickPluginsPath: 'Choose plugins folder',
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
      /** Conversation search (title + message-body results) */
      searchScopeTopics: 'Conversations',
      searchScopeMessages: 'Messages',
      searchFailed: 'Search failed, please retry',
      searchUntitledTopic: '(untitled conversation)',
      searchOpenFailed: 'Could not open this conversation (it may have been deleted)',
      emptyTopics: 'No conversations yet',
      topicDeleteBlocked: 'Running, cannot delete',
      topicDelete: 'Delete conversation',
      topicRunning: 'Conversation is running',
      /** Row leading dot (breathing, yellow): waiting for your answer / approval */
      topicAwaiting: 'Waiting for your confirmation',
      /** Row leading dot (breathing, green): the turn just finished and you have not opened it */
      topicCompleted: 'Completed — click to view',
      topicActions: 'Conversation actions',
      /* Conversation row "⋯" menu: pin / rename / fork / open in app / archive */
      topicPin: 'Pin conversation',
      topicUnpin: 'Unpin conversation',
      topicPinned: 'Pinned',
      topicFork: 'Fork conversation',
      topicForkTitle: '{{title}} (fork)',
      topicForkDone: 'Forked — the new conversation is open',
      topicForkFailed: 'Failed to fork',
      topicOpenInApp: 'Open in app',
      topicOpenInAppEmpty: 'No available app detected',
      topicArchive: 'Archive conversation',
      topicUnarchive: 'Unarchive',
      topicArchiveBlocked: 'Running — cannot archive',
      topicArchivedTitle: 'Archived',
      topicArchivedEmpty: 'No archived conversations',
      topicArchiveDone: 'Archived — moved into the Archived group',
      topicUnarchiveDone: 'Unarchived',
      topicArchiveFailed: 'Failed to archive',
      topicPinFailed: 'Failed to pin',
      topicArchivedGroup: 'Archived {{count}}',
      topicArchivedExpand: 'Expand archived conversations',
      topicArchivedCollapse: 'Collapse archived conversations',
      topicRenameTitle: 'Rename conversation',
      topicNamePlaceholder: 'Conversation name',
      topicNameRequired: 'Please enter a conversation name',
      topicRenameSuccess: 'Conversation renamed',
      topicRenameFailed: 'Failed to rename',
      workspaceActions: 'Workspace actions',
      workspaceHasRunning: 'A conversation is running',
      /** Workspace row "⋯ → Show in folder": the file manager is called differently per platform */
      workspaceRevealInFolder: 'Show in folder',
      workspaceRevealInFinder: 'Show in Finder',
      workspaceRevealInFileManager: 'Show in file manager',
      workspaceCreateFailed:
        'Failed to create the workspace — check that the folder is writable and retry',
      workspaceDeleteFailed: 'Failed to delete the workspace — please retry',
      workspaceSwitchFailed:
        'Could not switch workspace. Check that the folder still exists and try again.',
      workspaceDelete: 'Delete workspace',
      workspaceDeleteConfirmTitle: 'Delete workspace',
      workspaceDeleteConfirmContent:
        'Delete "{{name}}"? All conversations and memories in this workspace will be deleted too.',
      newSession: 'New conversation',
      newSessionRunning: 'The previous run keeps going in the background — reopen it anytime',
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
      teamModeLabel: 'Enable agent teamwork',
      teamModeHint: 'Lets the main agent and subagents share the task board',
      teamModeFailed: 'Failed to toggle agent teamwork',
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
      permissionLabel: 'Permission',
      toolsLabel: 'Tools',
      toolsAria: 'Choose tools',
      toolsEmpty: 'No tools available',
      toolsSearchPlaceholder: 'Search tools',
      skillsLabel: 'Skills',
      skillsAria: 'Choose skills',
      skillsEmpty: 'No skills available',
      skillsSearchPlaceholder: 'Search skills',
      mcpLabel: 'MCP',
      mcpAria: 'Choose MCP servers',
      mcpEmpty: 'No MCP servers yet — add one under More → MCP',
      mcpSearchPlaceholder: 'Search MCP servers',
      pickerNoMatch: 'No matches',
      pickerSaveFailed: 'Failed to save, please retry',
      /** "/" command menu (opened by a leading slash in the composer; Goal / Plan rows) */
      commands: {
        aria: 'Commands',
        groupAdd: 'Add',
        goalLabel: 'Goal',
        goalDescription: 'Set or view a long-term task goal',
        planLabel: 'Plan',
        planDescription: 'Enter or leave plan mode',
        empty: 'No matching commands',
        noTopic: 'Send a message first to create the conversation, then use this command'
      }
    },
    /** Tool source tag shown at the right of a tool name (system / plugin / MCP) */
    toolSource: {
      system: 'System',
      plugin: 'Plugin',
      mcp: 'MCP'
    },
    /** Plan mode: composer badge and enter/leave feedback */
    planMode: {
      badge: 'Plan mode',
      badgeAria: 'Plan mode is on; click to leave',
      activeHint: 'Plan mode: explore and plan first; work starts after you approve the plan',
      enabled: 'Plan mode on: Rita plans first and waits for your approval',
      disabled: 'Plan mode off',
      switchFailed: 'Failed to switch plan mode'
    },
    /** Inline goal card (above the composer) */
    goalInline: {
      tag: 'Goal',
      newTarget: 'New goal',
      newTargetHint: 'Type it in the composer below',
      newTargetAction: 'Enter to start · Esc to cancel',
      editing: 'Editing',
      add: 'Set a long-term goal for this conversation…',
      editHint: 'Click to edit',
      composePlaceholder: 'Type a goal…',
      composeFlag: 'Goal · Enter to run · Esc to cancel',
      composeHint: 'Enter to run · Esc to cancel',
      roundsLimit: 'Round limit',
      roundsLimitDefault: 'Default 256',
      editTitle: 'Edit goal',
      enterRun: 'Start',
      lineBreak: 'new line',
      start: 'Start',
      startMessage: 'Start executing the goal: {{text}}',
      rounds: '{{rounds}} rounds',
      saveFailed: 'Failed to save goal: ',
      actionFailed: 'Goal action failed: '
    },
    /** Goal dialog (opened from the composer command menu) */
    goalDialog: {
      title: 'Goal',
      subtitle:
        "Set or view this conversation's long-term goal. A goal keeps running automatically until it completes, is paused, or reaches its round limit.",
      emptyHint:
        'No goal yet. Describe what should be pursued over multiple rounds; Rita continues automatically after each round.',
      objectiveLabel: 'Objective',
      objectivePlaceholder: 'e.g. implement the migration plan, add tests and open a PR',
      roundsLabel: 'Round limit',
      roundsHint: 'Maximum automatic continuation rounds (default 256)',
      create: 'Create goal',
      save: 'Save changes',
      pause: 'Pause',
      resume: 'Resume',
      complete: 'Mark complete',
      clear: 'Clear goal',
      newGoal: 'New goal',
      phaseActive: 'Active',
      phasePaused: 'Paused',
      phaseBlocked: 'Blocked',
      phaseComplete: 'Complete',
      rounds: '{{current}} / {{max}} rounds started',
      blockedReason: 'Blocked: {{code}} · {{message}}',
      activeHint:
        'The goal continues automatically after each round until it is complete or paused.',
      pausedHint: 'The goal is paused; click Resume to re-enable automatic continuation.',
      completeHint: 'The goal is complete; you can start a new one.',
      objectiveRequired: 'Describe the goal first',
      missingGoal: 'This conversation has no goal',
      created: 'Goal created',
      saved: 'Goal saved',
      cleared: 'Goal cleared',
      close: 'Close',
      createFailed: 'Failed to create the goal: {{message}}',
      updateFailed: 'Failed to update the goal: {{message}}',
      clearFailed: 'Failed to clear the goal: {{message}}',
      clearConfirmTitle: 'Clear this goal?',
      clearConfirmBody:
        'The goal is deleted and automatic continuation stops; the conversation itself is untouched.',
      clearConfirmOk: 'Clear',
      cancel: 'Cancel'
    },
    /** Inline plan tray (above the composer) */
    planInline: {
      tag: 'Plan',
      activeHint: 'Plan mode is on · a full plan is required before any code changes',
      exit: 'Leave plan mode',
      waiting: 'Awaiting approval',
      editPlan: 'Edit plan',
      save: 'save',
      savePlan: 'Save changes',
      cancel: 'Cancel',
      feedbackPlaceholder: 'Want changes? Add feedback here — the composer stays free…',
      editedNote: 'Plan edited; approving sends the revised plan as the final one.'
    },
    /** Plan review dialog (exit_plan_mode): full plan + approve / keep planning */
    planReview: {
      title: 'Plan review',
      approve: 'Approve and start',
      keepPlanning: 'Keep planning',
      feedbackLabel: 'Feedback (optional)',
      feedbackPlaceholder: 'What should change? Tell Rita how to revise the plan…',
      hint: 'Approving turns plan mode off and Rita starts executing the plan; "Keep planning" sends your feedback back for another revision.',
      emptyPlan: '(the plan is empty)'
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
      defaultChanged: 'Default permission mode updated',
      switchFailed: 'Failed to switch the permission mode'
    },
    sandbox: {
      label: 'Sandbox',
      full: 'full enforcement',
      partial: 'partial enforcement',
      unavailable: 'unavailable',
      loading: 'Loading…',
      fullHint:
        'Write restrictions are enforced by the operating system: everything outside the workspace is denied',
      partialHint:
        'Write restrictions are enforced by the operating system; the restricted token keeps Everyone and NTFS hard links can alias files, so enforcement is partial (known boundary)',
      unavailableHint:
        'No kernel-level isolation is available on this platform, so commands are refused instead of running unconfined: {{reason}}',
      backendWindows: 'Windows restricted token + ACL',
      backendBwrap: 'Linux bubblewrap',
      backendLandlock: 'Linux Landlock',
      backendSeatbelt: 'macOS Seatbelt',
      cleanup: 'Clean workspace grants',
      cleanupHint:
        'Removes the sandbox ACEs left on the workspace ({{path}}); only meaningful for the Windows backend',
      cleanupNoWorkspace: 'No workspace selected yet — nothing to clean',
      cleanupDone: 'Workspace sandbox grants cleaned',
      cleanupFailed:
        'Failed to clean the sandbox grants (backend unsupported or workspace unavailable)'
    },
    approval: {
      title: 'Your approval is required',
      toolLabel: 'Tool',
      detailLabel: 'Operation',
      allowOnce: 'Allow once',
      deny: 'Deny',
      escalationNote: 'The model asks to escalate to "{{mode}}" for one call: {{justification}}',
      footerHint:
        'This allows the call once; the same operation will ask again. Use "Stop" to end the turn.',
      inlineSubtitle: 'This call exceeds the current permission — waiting for your decision',
      inlineHint:
        'Applies to this call only; change the persistent mode from the composer permission selector.',
      deciding: 'Deciding…'
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
      openStart: 'Start',
      toggleSidebar: 'Sidebar',
      togglePanel: 'Workspace panel',
      toggleTerminal: 'Terminal',
      generating: 'Generating'
    },
    /** Right-side persistent terminal panel (human UI) */
    terminalPanel: {
      title: 'Terminal',
      runningCount: '{{count}} running',
      loading: 'Loading terminal sessions…',
      tooMany: 'At most 3 terminals per conversation',
      noShell: 'No usable shell found (pwsh / cmd / bash)',
      failed: 'Terminal operation failed, please retry'
    },
    /** Start page: tool launcher (sidebar "Start") */
    startPage: {
      title: 'Start',
      workspace: {
        title: 'Workspace files',
        description: 'Browse files in the conversation workspace'
      },
      terminal: {
        title: 'New terminal',
        description: 'Run commands in the conversation workspace',
        running: '{{count}} running'
      },
      browser: {
        title: 'Browser',
        description: 'Browse the web'
      },
      more: {
        title: 'More tools',
        description: 'Skills, MCP, memory and agent settings'
      }
    },
    /** In-app browser panel (Electron webview) */
    browserPanel: {
      addressPlaceholder: 'Enter a URL or search',
      back: 'Back',
      forward: 'Forward',
      reload: 'Reload',
      blankTab: 'New tab',
      newTab: 'New tab',
      tabSearch: 'Search tabs',
      tabSearchPlaceholder: 'Search tabs',
      tabSearchShortcut: 'Ctrl+Shift+A',
      openTabs: 'Open tabs',
      noMatchingTabs: 'No matching tabs',
      recentlyClosed: 'Recently closed',
      noRecentlyClosed: 'No recently closed tabs',
      timeJustNow: 'just now',
      timeMinutesAgo: '{{count}} min ago',
      timeHoursAgo: '{{count}} h ago',
      timeDaysAgo: '{{count}} d ago',
      loadFailed: 'Failed to load page: {{reason}}'
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
      dispatched: 'Subagent task dispatched',
      subAgentRunning: '{{name}} · Running…',
      subAgentError: '{{name}} · Error',
      subAgentCompleted: '{{name}} · Completed',
      subAgentExecuting: 'The agent is working…',
      silentGenerating: 'Generating…',
      taskList: 'Task list',
      /** Changed-files badge on a task segment header */
      changedFiles: '{{count}} file(s) changed',
      changedFilesTip:
        '{{files}} file(s) changed in this step · {{pending}} awaiting review (click to diff)',
      toolOpenFile: 'Open file',
      deliveredFiles: 'Delivered files',
      workEditedFiles: 'Edited {{count}} file(s)',
      workShowAll: 'Show all ({{count}} more)',
      workCollapse: 'Collapse',
      workOpen: 'Open',
      openInApp: 'Open in app',
      openWith: 'Open with…',
      openWithDefault: 'System default app',
      openWithFailed: 'Could not open: {{reason}}',
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
      toolBackgroundJob: 'background · {{id}}',
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
    usageMeter: {
      tokens: '{{value}} tok',
      cacheHit: 'Cache hit {{percent}}%',
      contextAria: 'Context used {{percent}}% (current model window {{window}} tok)',
      turnLive: 'This turn: {{calls}} calls · {{value}} tok',
      turnLiveHint:
        'Live total for this turn (updated after each model call). The session total takes over once it ends.'
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
      headerTitle: 'Your confirmation is needed',
      okText: 'Submit answer',
      cancelText: 'Cancel',
      otherOption: 'Other',
      customPlaceholder: 'Type your answer…',
      singleHint: 'The turn continues after you answer; you can also cancel',
      progress:
        'Question {{current}} / {{total}} · answer to move to the next one; the turn continues after the last',
      prev: 'Previous',
      next: 'Next',
      cancelHint: 'Cancelling continues the turn without waiting',
      required: 'Answer this question first'
    },
    proposalBar: {
      ariaLabel: 'AI recommended action, editable before sending',
      send: 'Send',
      dismiss: 'Dismiss'
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
      inactive: 'Inactive',
      conversation: {
        backToMain: 'Back to main agent',
        breadcrumbMain: 'Main agent',
        loading: 'Loading conversation…',
        empty: 'This subagent has no output yet',
        missing:
          'This subagent conversation no longer exists (it may have been removed with its topic or session)',
        placeholder: 'Send a message to continue this subagent conversation…',
        queuedCount: '{{count}} message(s) queued',
        sendFailed: 'Failed to send: {{reason}}',
        open: 'Open conversation'
      }
    },
    collab: {
      agentsCount: '{{count}} subagents',
      tasksCount: '{{count}} tasks',
      summarySeparator: ' · ',
      sectionAgents: 'Subagents',
      sectionTasks: 'Shared tasks',
      taskProgress: '{{running}} in progress · {{pending}} pending · {{completed}} completed',
      agentTaskCount: '{{count}} task(s)',
      agentUsage: '{{tokens}} tok',
      taskOpenOwner: 'This task is owned by a subagent; click to open its session'
    },
    team: {
      unowned: 'Unowned',
      blockedBy: 'Waiting for {{tasks}}',
      owner: 'Owner: {{name}}'
    },
    backgroundJobs: {
      running: 'Running',
      stopping: 'Stopping',
      completed: 'Completed',
      failed: 'Failed',
      killed: 'Stopped',
      runningCount: '{{count}} running',
      totalCount: '{{count}} total',
      title: 'Background tasks',
      stop: 'Stop task',
      stopFailed: 'Failed to stop the task: {{reason}}',
      alreadyFinished: 'The task has already finished',
      output: 'Output',
      noOutput: 'No output yet',
      loadingOutput: 'Loading output…',
      outputFailed: 'Failed to read the output: {{reason}}',
      outputTruncated: '(output too long; showing the most recent part)',
      autoFollow: 'Auto-follow',
      backToBottom: 'Back to bottom',
      startedAt: 'Started at {{time}}',
      finishedAt: 'Finished at {{time}}',
      durationUnderSecond: '<1s',
      durationSeconds: '{{count}}s',
      durationMinutes: '{{minutes}}m {{seconds}}s',
      durationHours: '{{hours}}h {{minutes}}m'
    },
    fileExplorer: {
      title: 'Resource editor',
      refresh: 'Refresh',
      loading: 'Loading...',
      empty: 'Empty folder',
      openFailed: 'Failed to open the file',
      saveFailed: 'Failed to save the file',
      pendingReview: '{{count}} to review',
      /** Change records are not files (editing one file 10 times = 10 records), so the title bar's primary count is files */
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
  /* ── agentSettings ── */
  /* Agent settings page strings. Keep keys identical to the zh-CN source of truth. */
  agentSettings: {
    pageTitle: 'Agents',
    pageDescription:
      'Manage the subagents that can take delegated work; pick tools and skills below the chat input',
    sections: {
      mainAgent: 'Main agent',
      subagents: 'Subagents',
      runtime: 'Runtime & security',
      runtimeDesc:
        'Default permission mode for new conversations plus the sandbox status; when no sandbox backend is available, commands are refused instead of running unconfined.'
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
  /* ── memorySettings ── */
  memorySettings: {
    page: {
      title: 'Memory (Mnemon)',
      description:
        'Three layers of memory: runtime memory (injected every turn), long-term memory spaces (recalled on demand), and project documents (full archives). Stored under the memory root directory and isolated per session scope: one set per workspace and one per plugin (plugin conversations keep their own memory), so they never mix.'
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
      /** Shown when a plugin conversation is active; the workspace scope stays unlabelled */
      scopePlugin: 'Plugin "{{name}}"',
      /** Shown in chat mode: that memory belongs to the mode itself (it has no workspace) */
      scopeChat: 'Chat',
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
        'Enter what to remember about the project, e.g. the refactor plan is final and uses the in-house AI runtime',
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
    }
  },
  /* ── skillsSettings ── */
  skillsSettings: {
    pageTitle: 'Skills',
    pageDescription:
      'Configure the global Skills storage directory. Each subfolder is loaded as a separate Skill. Skills are never enabled by default: pick the ones to use under the chat input (or in a scheduled task). Click a card to read the skill body (frontmatter stripped); use the edit/delete actions on the card to manage the raw SKILL.md.',
    dirSectionTitle: 'Skills storage directory',
    dirSectionDescription: 'Every subdirectory containing a SKILL.md file counts as one Skill',
    dirPlaceholder: 'e.g. D:\\skills (leave empty to disable)',
    dirCurrent: 'Currently active: {{path}}',
    listTitle: 'Discovered skills ({{count}})',
    searchPlaceholder: 'Search skills',
    searchNoMatch: 'No matching skills',
    detailTitle: 'Skill content',
    detailEmpty: 'This skill has no body content.',
    detailFailed: 'Failed to read the skill content',
    detailFailedWithReason: 'Failed to read the skill content: {{reason}}',
    edit: 'Edit',
    delete: 'Delete',
    editTitle: 'Edit skill "{{name}}"',
    editHint:
      'Raw SKILL.md (including frontmatter). It is written back as-is; the card title/description come from the name / description fields in the file.',
    editPlaceholder: 'Edit the raw SKILL.md here',
    editLoadFailed: 'Failed to read the raw skill file',
    editLoadFailedWithReason: 'Failed to read the raw skill file: {{reason}}',
    emptyContent: 'SKILL.md cannot be empty',
    saveFailed: 'Failed to save the skill',
    saveFailedWithReason: 'Failed to save the skill: {{reason}}',
    savedSkill: 'Skill saved',
    deleteConfirmTitle: 'Delete skill "{{name}}"?',
    deleteConfirmBody:
      'This removes the skill directory "{{id}}" and its SKILL.md. The operation cannot be undone. Make sure the directory name matches the skill you mean to delete.',
    listLoadFailed:
      'Failed to read the skills directory (missing, unreadable or locked). Check the path and try again.',
    deleteFailed: 'Failed to delete the skill',
    deleteFailedWithReason: 'Failed to delete the skill: {{reason}}',
    deleted: 'Skill deleted',
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
      'Connect external MCP servers (a local stdio process or a remote HTTP/SSE endpoint). Servers are connected but not injected by default: choose the servers to use under the chat input; the tool checkboxes here are the default list used by subagents. Statuses come from the last connection attempt — use "Reconnect" to refresh.',
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
    },
    /** Resource browser (server row "resources" action → modal) */
    resources: {
      open: 'Browse resources',
      title: 'Resources · {{name}}',
      listTitle: 'Resources',
      templatesTitle: 'Resource templates',
      empty: 'This server exposes no resources',
      listFailed: 'Could not read resources: {{reason}}',
      loadMore: 'Load more',
      previewTitle: 'Preview',
      previewEmpty: 'Pick a resource on the left to preview it',
      emptyContent: '(this resource has no content)',
      binaryNote: 'Binary content ({{mime}}, about {{bytes}} bytes) cannot be previewed yet'
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
      rowEmpty: 'No plugins folder yet',
      rowDesc: 'Every plugin lives in this folder, one subfolder each',
      saved: 'Plugins folder set to {{path}}',
      moved: 'Plugins folder set; {{count}} existing plugin(s) were moved there too'
    },
    list: {
      title: 'Drafts',
      new: 'New draft',
      empty:
        'No plugins yet. Ask the assistant for one ("build me a pomodoro plugin"), or use "New draft" to scaffold a skeleton.',
      needRoot: 'No plugins folder yet'
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
      note: 'The draft comes with everything: page, settings page, an AI tool for the assistant, event push and data purge. Let the assistant delete what you do not need.'
    }
  },

  /* ── Schedules page (sidebar) ── */
  schedulesPage: {
    title: 'Schedules',
    description:
      'Let the assistant run tasks in a chosen conversation on a schedule. Tasks run only while the app is running; missed runs are skipped, not replayed.',
    refresh: 'Refresh',
    newTask: 'New task',
    filterAll: 'All',
    filterEnabled: 'Enabled',
    filterPaused: 'Paused',
    searchPlaceholder: 'Search title or prompt…',
    summary: '{{count}} task(s) · next run: {{next}}',
    summaryNoNext: '{{count}} task(s) · nothing scheduled next',
    stateEnabled: 'Enabled',
    statePaused: 'Paused',
    pause: 'Pause',
    resume: 'Resume',
    edit: 'Edit',
    delete: 'Delete',
    runOnce: 'Run now',
    viewRuns: 'View runs',
    duplicate: 'Duplicate',
    empty: 'No scheduled tasks yet',
    emptyHint: 'Create a recurring task for one conversation, or ask the assistant in a chat.',
    loadFailed: 'Failed to load scheduled tasks: {{reason}}',
    actionFailed: 'The action failed, please retry',
    deleteTitle: 'Delete "{{title}}"?',
    deleteBody: 'The task and its run history are deleted permanently; this cannot be undone.',
    deleteConfirm: 'Delete',
    cancel: 'Cancel',
    ruleDaily: 'Daily at {{time}}',
    ruleEvery: 'Every {{minutes}} min',
    ruleOnce: 'Once · {{time}}',
    nextAt: 'Next: {{time}}',
    nextNone: 'Will not run',
    nextExpired: 'Expired',
    lastRunAt: 'Last: {{time}} · {{status}}',
    lastNone: 'Never run',
    statusCompleted: 'succeeded',
    statusCancelled: 'cancelled',
    statusFailed: 'failed',
    conversation: 'Conversation: {{title}}',
    conversationUnknown: 'Conversation: {{id}}',
    conversationLabel: 'Conversation',
    runLabel: 'Run',
    runInfo: 'tools {{tools}} · skills {{skills}} · MCP {{mcp}}',
    followConversation: 'follows the conversation',
    nextPrefix: 'Next',
    remainingDays: 'in {{days}}d {{hours}}h',
    remainingHours: 'in {{hours}}h {{minutes}}m',
    remainingMinutes: 'in {{minutes}}m',
    dueNow: 'due now',
    editorNewTitle: 'New scheduled task',
    editorEditTitle: 'Edit scheduled task',
    editorDesc:
      'When due, the assistant starts a new turn in the chosen conversation. Tasks run only while the app is running; missed runs are skipped.',
    fieldConversation: 'Conversation',
    fieldConversationHint:
      'The task runs in a conversation of the chosen mode, regardless of the mode currently open.',
    fieldMode: 'Mode',
    modeChat: 'Chat',
    modeWork: 'Work',
    modePlugin: 'Plugin',
    fieldModel: 'Model',
    modelPlaceholder: 'Empty = default model',
    newSessionOption: 'New conversation (each run)',
    newSessionTag: 'New conversation',
    fieldWorkspace: 'Target workspace',
    fieldPlugin: 'Target plugin',
    fieldAgentConfig: 'Enabled for this run (optional)',
    fieldToolsHint: 'Tools: empty = follow conversation/default',
    fieldSkillsHint: 'Skills: empty = none enabled',
    fieldMcpHint: 'MCP servers: empty = none enabled',
    fieldAgentConfigHint:
      'Applies only to turns triggered by this task; empty = follow the target conversation.',
    fieldTool: 'Tools',
    fieldSkill: 'Skills',
    fieldMcp: 'MCP',
    toolsPlaceholder: 'Empty = follow conversation/default',
    skillsPlaceholder: 'Empty = none',
    mcpPlaceholder: 'Empty = none',
    invalidTarget: 'Choose a conversation or New conversation',
    invalidModel: 'The selected model is unavailable; check that it is enabled in model settings',
    fieldWhen: 'Schedule',
    whenDaily: 'Daily',
    whenEvery: 'Interval',
    whenOnce: 'Once',
    fieldTime: 'Time',
    fieldMinutes: 'Interval (minutes)',
    fieldDateTime: 'Date & time',
    fieldPrompt: 'Task prompt',
    fieldPromptHint:
      'Describe the goal, where to write the result and the expected format; nobody will be there to answer follow-ups.',
    promptPlaceholder:
      "e.g. Summarise this week's commits and todos into the weekly report doc, then list three takeaways.",
    previewNext: 'Next run: {{time}}',
    create: 'Create task',
    save: 'Save changes',
    fieldTitleOptional: 'Name (optional)',
    fieldTitle: 'Name',
    titlePlaceholder: 'Name this task',
    titleRequired: 'Enter a task name',
    saved: 'Saved',
    created: 'Task created',
    saving: 'Saving…',
    invalidPrompt: 'Enter a task prompt',
    invalidMinutes: 'The interval must be between 5 and 10080 minutes',
    invalidTime: 'Enter a valid time',
    invalidConversation: 'Choose a conversation',
    runsTitle: 'Run history',
    runsDesc: 'Kept permanently; nothing is pruned.',
    runPanelProcess: 'Process',
    runPanelArtifacts: 'Artifacts',
    runPanelDuration: '{{seconds}}s',
    runPanelTokens: '{{count}} tokens',
    runPanelConversation: 'Conversation #{{topicId}}',
    runPanelNoSteps: 'No tool calls in this run',
    runPanelNoArtifacts: 'This run produced no files',
    runPanelDeliverable: 'Deliverable',
    runPanelOpenConversation: 'Open conversation',
    runPanelOpen: 'Open',
    runPanelClose: 'Close',
    runPanelNoDuration: 'Duration unknown',
    runRowHint: 'View run details',
    runPanelRunOrdinal: 'run {{index}} / {{total}}',
    runPanelSwitch: 'Switch run',
    runStepsCount: '{{count}} steps',
    runArtifactsCount: '{{count}} artifacts',
    runsEmpty: 'No runs recorded yet',
    runsCount: '{{count}} run(s)',
    runsLoadMore: 'Load more',
    runsStatusCompleted: 'succeeded',
    runsStatusCancelled: 'cancelled',
    runsStatusFailed: 'failed',
    noTopics: 'This workspace has no conversations yet. Create one before adding a task.'
  },

  /* ── Settings → Web search ── */
  searchSettings: {
    pageTitle: 'Web search',
    pageDescription:
      'Choose the search service used by the assistant. Configuration stays on this machine and every search goes through the same interface.',
    sectionServices: 'Search services',
    sectionServicesDesc: 'Pick one default · built-in search is used when nothing is configured',
    sectionBehavior: 'Behavior',
    sectionBehaviorDesc: 'Only affects search requests',
    on: 'On',
    off: 'Off',
    builtinName: 'Built-in search',
    builtinDesc: 'No configuration needed, works out of the box',
    deepseekName: 'DeepSeek search',
    deepseekDesc: 'Web search provided by DeepSeek',
    tavilyName: 'Tavily',
    tavilyDesc: 'Agent-optimised web search · 1000 free credits per month',
    currentDefault: 'Default',
    connected: 'Connected',
    notConfigured: 'Not configured',
    reuseHint:
      'A key for the same vendor is configured under Settings → Model; you can paste the same key here.',
    test: 'Test',
    configure: 'Configure',
    clearKey: 'Clear key',
    testing: 'Testing…',
    testingShort: 'Testing',
    testSuccess: 'Connected ({{ms}}ms)',
    testFailed: 'Connection failed: {{reason}}',
    autoFallback: 'Fall back to built-in search on failure',
    autoFallbackHint:
      'If the selected service fails or times out (10 seconds), use the built-in search and show a small hint once.',
    includeContent: 'Request page content',
    includeContentHint: 'More complete results, but uses more context and takes longer.',
    saveFailed: 'Failed to save',
    saveSuccess: 'Key saved',
    clearSuccess: 'Key cleared',
    clearConfirmTitle: 'Clear the key for {{name}}?',
    clearConfirmBody:
      'The service will stop working. If it was the default, built-in search is used instead.',
    loadFailed: 'Failed to load search settings: {{reason}}',
    configTitle: 'Configure {{name}}',
    configDesc: 'Paste the key to enable it; it is tested before saving.',
    keyLabel: 'Key',
    keyPlaceholder: 'Paste the key',
    keyEmpty: 'Enter a key',
    keyInvalid: 'The key cannot contain spaces',
    keyHelp: 'No key yet? {{link}}',
    keyHelpLink: 'Get one',
    saveAndTest: 'Save and test',
    cancel: 'Cancel',
    notConfiguredHint: 'Configure a key before making this the default.',
    defaultChanged: 'Default search service updated',
    errorLabels: {
      'not-configured': 'key not configured',
      unauthorized: 'the key is invalid or expired',
      'rate-limited': 'the search service is rate limited',
      timeout: 'request timed out',
      network: 'network error',
      'provider-error': 'the search service returned an error',
      'invalid-response': 'unreadable response',
      'invalid-query': 'invalid query',
      'invalid-key': 'invalid key format',
      'save-failed': 'failed to save'
    }
  }
}
