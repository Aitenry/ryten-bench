import type { notesZhCN } from './zh-CN'

/** `typeof notesZhCN` 约束：与中文源语言逐键对齐，缺译/多键在编译期即报错 */
export const notesEnUS: typeof notesZhCN = {
  /* ── notes（原 locales/en-US/home.ts） ── */
  /* Notes module (notes dashboard / document tree / document & todo editors / preview modals).
     Keep key names identical to the zh-CN source of truth. */
  notes: {
    /* Nouns (shared by tree section titles, search groups, stat blocks, breadcrumb fallbacks) */
    term: {
      doc: 'Document',
      docLibrary: 'Document library',
      todo: 'Todos',
      wiki: 'Knowledge base',
      directory: 'Directory',
      graph: 'Knowledge graph',
      properties: 'Properties'
    },
    /* Todo / document status names */
    status: {
      pending: 'To do',
      doing: 'In progress',
      done: 'Done'
    },
    /* Breadcrumb */
    breadcrumb: {
      root: 'Notes',
      docWithId: 'Document {{id}}',
      todoWithId: 'Todo {{id}}'
    },
    /* Form field labels and placeholders */
    field: {
      title: 'Title',
      summary: 'Summary',
      tags: 'Tags',
      cover: 'Cover',
      coverImage: 'Cover image',
      coverAlt: 'Cover',
      dueDate: 'Due date',
      priority: 'Priority',
      status: 'Status',
      category: 'Category',
      startTime: 'Started',
      completedTime: 'Completed',
      createdTime: 'Created',
      updatedTime: 'Updated',
      directoryName: 'Directory name',
      tagPlaceholder: 'Type a tag and press Enter',
      tagPlaceholderMore: 'Add another…',
      selectImage: 'Choose image',
      changeImage: 'Change image',
      uploadImage: 'Upload image',
      removeImage: 'Remove image'
    },
    /* Left document tree */
    tree: {
      createNamed: 'New {{name}}'
    },
    /* In-tree search */
    search: {
      placeholder: 'Search documents, todos, knowledge bases',
      noResults: 'No matches'
    },
    /* Documents */
    doc: {
      untitled: 'Untitled document',
      create: 'New document',
      import: 'Import document',
      importing: 'Importing document...',
      importSuccess: 'Document imported',
      importFailed: 'Failed to import document',
      creating: 'Creating document...',
      createSuccess: 'Document created',
      createFailed: 'Failed to create document',
      delete: 'Delete document',
      deleteHard: 'Delete permanently',
      deleteTitle: 'Delete "{{name}}"?',
      deleting: 'Deleting document...',
      deleteSuccess: 'Document deleted',
      deleteFailed: 'Failed to delete document',
      archiveToOtherDir: 'Archive to another directory',
      archiveToWiki: 'Archive to knowledge base',
      createdAt: 'Created {{date}}',
      titleWithId: 'Document {{id}}',
      notFound: 'Document not found or deleted',
      empty: 'No documents',
      propsSaved: 'Document properties saved',
      propsSaveFailed: 'Failed to save document properties'
    },
    /* Todos */
    todo: {
      untitled: 'Untitled todo',
      create: 'New todo',
      addTitle: 'Add todo',
      editTitle: 'Todo details',
      titlePlaceholder: 'Enter a todo title',
      categoryPlaceholder: 'Enter a category',
      contentPlaceholder: 'Write something… Markdown supported (# heading, - list, ``` code block)',
      creating: 'Adding todo...',
      createSuccess: 'Todo added',
      createFailed: 'Failed to add todo',
      saving: 'Saving todo...',
      updated: 'Todo updated',
      saveFailed: 'Failed to save todo',
      deleteTitle: 'Delete this todo?',
      actionStart: 'Start task',
      actionComplete: 'Mark complete',
      actionReactivate: 'Reactivate',
      updatingStatus: 'Updating status...',
      markedDoing: 'Marked as in progress',
      reactivated: 'Reactivated',
      statusUpdateFailed: 'Failed to update status',
      priority: 'Priority P{{level}}',
      duePrefix: 'Due ',
      overduePrefix: 'Overdue · ',
      metaCreated: 'Created {{time}}',
      metaUpdated: 'Updated {{time}}',
      metaStarted: 'Started {{time}}',
      metaCompleted: 'Completed {{time}}',
      empty: 'No todos',
      notFound: 'Todo not found or deleted'
    },
    /* Knowledge bases */
    wiki: {
      create: 'New knowledge base',
      edit: 'Edit knowledge base',
      titlePlaceholder: 'Knowledge base title',
      summaryPlaceholder: 'Knowledge base summary',
      creating: 'Creating knowledge base...',
      createSuccess: 'Knowledge base created!',
      createFailed: 'Failed to create knowledge base',
      saving: 'Saving knowledge base...',
      updated: 'Knowledge base updated',
      saveFailed: 'Failed to save knowledge base',
      delete: 'Delete knowledge base',
      deleteTitle: 'Delete "{{name}}"?',
      deleteContent:
        'The knowledge base and its directories will be removed. Documents inside them are kept.',
      deleting: 'Deleting knowledge base...',
      deleted: 'Knowledge base deleted',
      deleteFailed: 'Failed to delete knowledge base',
      empty: 'No knowledge bases',
      notFound: 'Knowledge base not found or deleted'
    },
    /* Knowledge base directories */
    dir: {
      create: 'New directory',
      createChild: 'New subdirectory',
      createSubTitle: 'New directory under "{{name}}"',
      renameTitle: 'Rename directory',
      defaultName: 'New directory',
      creating: 'Creating directory...',
      createSuccess: 'Directory created!',
      saving: 'Saving directory...',
      saved: 'Directory saved',
      saveFailed: 'Failed to save directory',
      delete: 'Delete directory',
      deleteTitle: 'Delete "{{name}}"?',
      deleteContent:
        'Documents in the directory will not be deleted; they will only be unlinked from it.',
      deleting: 'Deleting directory...',
      deleteSuccess: 'Directory deleted',
      deleteFailed: 'Failed to delete directory',
      removeDoc: 'Remove from directory',
      removeDocTitle: 'Remove "{{name}}" from "{{dir}}"?',
      removeDocContent: 'Only the directory link is removed; the document itself is kept.',
      removing: 'Removing...',
      removed: 'Removed from directory',
      removeFailed: 'Failed to remove'
    },
    /* Knowledge graph entry */
    graph: {
      view: 'View graph'
    },
    /* Save status bar of the document / todo editors */
    editor: {
      saving: 'Saving…',
      unsaved: 'Unsaved',
      saved: 'Saved',
      savedWithTime: 'Saved {{time}}',
      hint: 'Ctrl+S to save now · auto-save after editing'
    },
    /* Right outline panel */
    outline: {
      title: 'Outline',
      empty: 'No headings',
      wordCount: 'Words',
      created: 'Created',
      updated: 'Updated'
    },
    /* Home dashboard */
    dashboard: {
      greetingNight: 'Working late',
      greetingMorning: 'Good morning',
      greetingAfternoon: 'Good afternoon',
      greetingEvening: 'Good evening',
      welcomeBack: '{{greeting}}, welcome back',
      dateFormat: 'dddd, MMMM D, YYYY',
      subtitle: 'Pick something from the document tree, or create a new one to start',
      recentUpdate: 'Updated {{date}}',
      pendingTodos: 'Open todos',
      overdueCount_one: '{{count}} overdue',
      overdueCount_other: '{{count}} overdue',
      noOverdue: 'None overdue',
      wikiSubtitle: 'Knowledge capture and archiving',
      todoSection: 'Todos',
      recentDocsSection: 'Recent documents',
      noPendingTodos: 'No open todos',
      noDocsHint: 'No documents yet — click "New document" to start writing'
    },
    /* Archive document modal */
    archive: {
      title: 'Archive "{{name}}" to a knowledge base directory',
      ok: 'Archive',
      stepWiki: '1. Choose a knowledge base',
      stepDirectory: '2. Choose a directory',
      selectWikiFirst: 'Choose a knowledge base first',
      noDirectories: 'This knowledge base has no directories',
      archiving: 'Archiving document...',
      success: 'Document archived!',
      failed: 'Failed to archive document'
    },
    /* Document properties modal */
    props: {
      title: 'Document properties',
      titleWithDoc: 'Properties · {{name}}',
      summaryPlaceholder: 'Describe this document in one sentence…'
    },
    /* Document preview modal */
    preview: {
      doc: 'Document preview',
      empty: 'No content'
    }
  },

  /* ── graph（原 locales/en-US/graph.ts） ── */
  /* 关系类型在画布 tooltip 里与头尾实体名直接拼接（`头 + 标签 + 尾`，见 GraphCanvas 的 edge
     formatter），中文原样拼接即可，英文单词之间需要空格，否则会渲染成 "Alicepart ofBob"。
     这一层空格写在词条值里，不改拼接逻辑。 */
  graph: {
    entityType: {
      person: 'Person',
      organization: 'Organization',
      concept: 'Concept',
      event: 'Event',
      location: 'Location',
      other: 'Other',
      technology: 'Technology',
      product: 'Product',
      system: 'System',
      document: 'Document',
      standard: 'Standard',
      facility: 'Facility',
      substance: 'Substance',
      process: 'Process',
      role: 'Role',
      skill: 'Skill',
      measure: 'Metric',
      artifact: 'Artifact',
      creature: 'Creature',
      realm: 'Tier'
    },
    relationType: {
      contains: 'contains',
      part_of: 'part of',
      is_a: 'is a',
      located_in: 'located in',
      depends_on: 'depends on',
      related_to: 'related to',
      leads_to: 'leads to',
      uses: 'uses',
      creates: 'creates',
      produces: 'produces',
      operates: 'operates',
      owns: 'owns',
      acquires: 'acquires',
      belongs_to: 'belongs to',
      governs: 'governs',
      monitors: 'monitors',
      employs: 'employs',
      mentors: 'mentors',
      friend_of: 'friend of',
      enemy_of: 'enemy of',
      loves: 'loves',
      family_of: 'family of',
      fights: 'fights',
      kills: 'kills'
    },
    empty: {
      noData: 'This knowledge base has no graph data yet',
      startBuild: 'Start building the graph',
      noSelection: 'Click a node in the graph to view its details'
    },
    toolbar: {
      stats: 'Entities {{entityCount}} | Relations {{relationCount}}',
      searchPlaceholder: 'Search entities...',
      allDocs: 'All documents',
      noDocs: 'No documents',
      appendModalTitle: 'Select documents to append to the graph',
      appendHint_one:
        'Documents already in the graph are hidden from this list ({{count}} document added)',
      appendHint_other:
        'Documents already in the graph are hidden from this list ({{count}} documents added)',
      appendSearchPlaceholder: 'Search and select documents...',
      allDocsAdded: 'All documents are already in the graph',
      appendConfirm: 'Append'
    },
    build: {
      confirmTitle: 'Confirm graph build',
      confirmContent:
        'The knowledge graph for "{{title}}" will be rebuilt and the existing graph data will be cleared. Continue?',
      confirmOk: 'Confirm and build',
      starting: 'Starting graph build...',
      started: 'Graph build started',
      startFailed: 'Failed to start the build: {{reason}}',
      completed: 'Graph build complete! Entities {{entityCount}}, relations {{relationCount}}',
      failed: 'Graph build failed: {{reason}}'
    },
    progress: {
      overallProgress: 'Overall progress',
      entityLabel: 'Entities',
      relationLabel: 'Relations',
      documentsProcessed: 'Processed {{processed}}/{{total}} documents',
      chunksProcessed: 'Processed {{processed}}/{{total}} chunks'
    },
    detail: {
      confidence: 'Confidence: {{percent}}%',
      description: 'Description',
      aliases: 'Aliases',
      sourceDocs_one: 'Source documents ({{count}})',
      sourceDocs_other: 'Source documents ({{count}})',
      docFallback: 'Document #{{id}}',
      relatedRelations_one: 'Relations ({{count}})',
      relatedRelations_other: 'Relations ({{count}})',
      noRelations: 'No relations',
      relationLine: '-- {{relation}} →',
      createdAt: 'Created',
      updatedAt: 'Updated'
    },
    canvas: {
      tooltipDescription: 'Description: {{description}}',
      edgeTooltip: '{{source}} {{relation}} {{target}}',
      showIsolated_one: 'Show {{count}} isolated node',
      showIsolated_other: 'Show {{count}} isolated nodes',
      hideIsolated_one: 'Hide {{count}} isolated node',
      hideIsolated_other: 'Hide {{count}} isolated nodes',
      isolatedHidden_one: '{{count}} isolated node hidden',
      isolatedHidden_other: '{{count}} isolated nodes hidden'
    }
  },

  /* ── graphSettings（原 locales/en-US/graphSettings.ts） ── */
  graphSettings: {
    pageTitle: 'Graph building',
    pageDescription: 'Configure knowledge graph building parameters and default models',
    build: {
      sectionTitle: 'Build parameters',
      maxConcurrencyTitle: 'Max concurrent LLM calls',
      maxConcurrencyDescription:
        'Number of parallel LLM requests while building the graph. Higher is faster, but puts more pressure on the API.',
      gleaningTitle: 'Gleaning second pass',
      gleaningDescription:
        'Scan again after entity extraction so missed entities are still picked up',
      gleaningThresholdTitle: 'Gleaning document threshold',
      gleaningThresholdDescription:
        'Gleaning only runs when the knowledge base has no more documents than this. Above it, the pass is skipped to save time.',
      chunkSizeTitle: 'Text chunk size',
      chunkSizeDescription:
        'Maximum characters per chunk when splitting Markdown text by heading level'
    },
    model: {
      sectionTitle: 'Default models',
      graphModelTitle: 'Model used for graph building',
      graphModelDescription:
        'The default model for building the knowledge graph. Leave empty to use the provider default.',
      graphModelPlaceholder: 'Use the provider default',
      embeddingTitle: 'Embedding model',
      embeddingDescription:
        'The model used for text vector embeddings; only providers tagged as embedding are listed',
      embeddingPlaceholder: 'No embedding model set',
      embeddingEmpty: 'No embedding model yet — add one in model settings first'
    }
  }
}
