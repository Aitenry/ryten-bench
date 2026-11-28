/**
 * Texts for tool execution results (**shown on the chat tool-result cards**, so they must follow
 * the UI language).
 *
 * Split with `messages.ts`: that side covers OS-level UI (tray/dialogs/startup page), this side is
 * the wording that tells the user what the tool holds.
 * The model reads the same content -- deliberately: whatever the card shows is what the model sees.
 *
 * Chinese is the source language; `enUS` is constrained by `typeof zhCN`, so missing or extra keys
 * are compile errors.
 *
 * The default Memory Space names are only the initial display text at creation time: business
 * logic looks up the archive space by structured `role`, never by name literals.
 */
export const zhCNToolResults = {
  mnemon: {
    /** How the hot-memory write target (target=user / memory) is phrased on the card */
    targets: {
      user: '用户画像',
      memory: '项目记忆'
    },

    /** Default display names for Memory Spaces (creation only; archive lookup uses role, not name) */
    defaultNames: {
      archiveSpace: '热记忆归档',
      archiveSpaceDescription: 'MEMORY 热记忆溢出的自动归档目标；内容为项目长期事实与经验。',
      untitledSpace: '未命名记忆空间',
      discoveredSpace: '记忆空间 {{id}}',
      discoveredSpaceDescription: '磁盘发现的记忆空间'
    },

    // ----- mnemon_runtime_memory: success texts assembled by the tool layer -----
    /* The count phrase is pulled out for pluralization: unchanged in Chinese, 1 entry / n entries in English */
    entryCount_one: '{{count}} 条',
    entryCount_other: '{{count}} 条',
    added: '已添加到{{target}}（{{used}}/{{limit}} 字节，共 {{entryCount}}）。',
    addedWithMaintenance:
      '已添加到{{target}}（{{used}}/{{limit}} 字节，共 {{entryCount}}）。已触发容量维护：{{summary}}',
    replaced: '已替换记忆条目。',
    removed: '已移除记忆条目。',

    /** RuntimeMemoryController.mutate result message (returned verbatim by the tool on failure) */
    runtimeMemory: {
      added: '已添加记忆',
      addedWithArchive: '已添加记忆（触发长期归档 {{entryCount}}）',
      replaced: '已替换记忆',
      removed: '已移除记忆',
      archiveFailed: 'MEMORY 热记忆容量不足，且长期归档失败：{{message}}'
    },

    // ----- mnemon_document_manage -----
    document: {
      createRequires: '创建档案需要 title 与 content',
      created: '已创建档案《{{title}}》（id={{id}}）',
      updateRequiresId: '更新档案需要 id',
      updated: '已更新档案《{{title}}》（revision={{revision}}）',
      archiveRequiresId: '归档档案需要 id',
      notFound: '档案不存在: {{id}}',
      archived: '已归档档案《{{title}}》：{{summary}}',
      defaultArchiveSummary: '由智能体归档'
    },

    // ----- mnemon_remember / mnemon_link / mnemon_forget -----
    rememberFailed: '沉淀失败: {{error}}',
    linked: '已建立 {{type}} 关系：{{sourceId}} → {{targetId}}',
    linkFailed: '建立关系失败: {{error}}',
    forgotten: '已软删除记忆 {{id}}',
    forgetFailed: '删除失败: {{error}}',

    // ----- mnemon_memory_body_create / update / merge -----
    createBody: '已创建记忆空间「{{name}}」（id={{id}}，已激活）',
    createBodyFailed: '创建失败: {{error}}',
    updateBody: '已更新记忆空间「{{name}}」（active={{active}}）',
    updateBodyFailed: '更新失败: {{error}}',
    mergeBodies: '合并完成：导入 {{imported}} 条，跳过重复 {{skipped}} 条',
    mergeBodiesDeactivated:
      '合并完成：导入 {{imported}} 条，跳过重复 {{skipped}} 条；源空间已设为未激活',
    mergeBodiesFailed: '合并失败: {{error}}',

    /**
     * Validation and failure messages: thrown by the service/storage layer, caught by the tool and
     * returned verbatim to the card, or shown by the tool runtime as a tool error, so they follow
     * the UI language as well.
     */
    errors: {
      // Hot memory
      contentRequired: '内容不能为空',
      entryTooLarge: '单条记忆超过上限 {{limit}} 字节',
      entryExists: '该记忆已存在（内容完全相同），无需重复添加',
      newContentRequired: '新内容不能为空',
      keyRequired: 'old_text 不能为空',
      keyNotFound: '未找到包含 "{{oldText}}" 的记忆条目',
      keyAmbiguous: '"{{oldText}}" 匹配到 {{count}} 条记忆，请提供更长的唯一子串',
      replaceOverLimit: '替换后超出容量上限（{{limit}} 字节），请先移除或合并部分条目',
      userOverLimit:
        'USER 热记忆容量不足（上限 {{limit}} 字节），且没有可合并的低优先级条目。请先移除或合并部分记忆。',
      unknownAction: '未知操作: {{action}}',

      // Archive hook
      archiveHookMissing: '未配置归档钩子',
      nothingToArchive: '没有可归档的记忆条目',
      hookArchivedNothing: '归档钩子未归档任何条目',

      // Long-term memory writes
      categoryInvalid: '类别必须为 {{values}}',
      sourceInvalid: '来源必须为 {{values}}',
      relationTypeInvalid: '关系类型必须为 {{values}}',
      selfRelation: '不能与自己建立关系',
      insightExists: '该记忆已存在（内容完全相同），如需更新请先 forget 旧条目',
      insightNotFound: '未找到记忆 {{id}}（可能已删除）',

      // Memory Spaces
      spaceNotActivated: '以下记忆空间未激活或不存在，不能读取: {{spaces}}',
      noActiveSpace: '没有已激活的记忆空间，请先创建或激活一个记忆空间',
      spaceNotFound: '记忆空间不存在: {{id}}',
      targetSpaceNotFound: '目标记忆空间不存在: {{id}}',

      // Project documents
      documentTooLarge: '单份文档超过上限 {{limit}} 字节',
      documentCapacityExceeded:
        '文档容量不足：active 总量上限 {{limit}} 字节（当前 {{current}}，需 {{needed}}）。请先归档部分文档。',
      documentCapacityExceededOnUpdate:
        '文档容量不足：更新后超出 active 总量上限，请先归档部分文档',
      documentNotFound: '文档不存在: {{id}}',
      documentArchived: '文档 {{id}} 已归档，不能更新（可先重建）',
      documentNotActive: '文档 {{id}} 不是 active 状态'
    },

    /** Hint when recall comes back empty */
    hint: {
      noMatchInActiveSpaces: '未在已激活记忆空间中找到匹配内容'
    }
  }
}

export const enUSToolResults: typeof zhCNToolResults = {
  mnemon: {
    targets: {
      user: 'User Profile',
      memory: 'Project Memory'
    },

    defaultNames: {
      archiveSpace: 'Memory Archive',
      archiveSpaceDescription:
        'Automatic archive target for MEMORY overflow; holds long-term project facts and lessons.',
      untitledSpace: 'Untitled Memory Space',
      discoveredSpace: 'Memory Space {{id}}',
      discoveredSpaceDescription: 'Memory space discovered on disk'
    },

    entryCount_one: '{{count}} entry',
    entryCount_other: '{{count}} entries',
    added: 'Added to {{target}} ({{used}}/{{limit}} bytes, {{entryCount}}).',
    addedWithMaintenance:
      'Added to {{target}} ({{used}}/{{limit}} bytes, {{entryCount}}). Capacity maintenance triggered: {{summary}}',
    replaced: 'Memory entry replaced.',
    removed: 'Memory entry removed.',

    runtimeMemory: {
      added: 'Memory entry added',
      addedWithArchive: 'Memory entry added ({{entryCount}} moved to long-term memory)',
      replaced: 'Memory entry replaced',
      removed: 'Memory entry removed',
      archiveFailed:
        'MEMORY hot memory is over capacity and long-term archiving failed: {{message}}'
    },

    document: {
      createRequires: 'Creating a document requires title and content',
      created: 'Document "{{title}}" created (id={{id}})',
      updateRequiresId: 'Updating a document requires id',
      updated: 'Document "{{title}}" updated (revision={{revision}})',
      archiveRequiresId: 'Archiving a document requires id',
      notFound: 'Document not found: {{id}}',
      archived: 'Document "{{title}}" archived: {{summary}}',
      defaultArchiveSummary: 'Archived by the agent'
    },

    rememberFailed: 'Failed to store the memory: {{error}}',
    linked: 'Linked {{type}}: {{sourceId}} → {{targetId}}',
    linkFailed: 'Failed to create the relation: {{error}}',
    forgotten: 'Memory {{id}} soft-deleted',
    forgetFailed: 'Delete failed: {{error}}',

    createBody: 'Memory Space "{{name}}" created (id={{id}}, activated)',
    createBodyFailed: 'Create failed: {{error}}',
    updateBody: 'Memory Space "{{name}}" updated (active={{active}})',
    updateBodyFailed: 'Update failed: {{error}}',
    mergeBodies: 'Merge complete: imported {{imported}}, skipped duplicates {{skipped}}',
    mergeBodiesDeactivated:
      'Merge complete: imported {{imported}}, skipped duplicates {{skipped}}; source spaces deactivated',
    mergeBodiesFailed: 'Merge failed: {{error}}',

    errors: {
      contentRequired: 'Content must not be empty',
      entryTooLarge: 'A single entry exceeds the {{limit}} byte limit',
      entryExists: 'That memory already exists (identical content); no need to add it again',
      newContentRequired: 'New content must not be empty',
      keyRequired: 'old_text must not be empty',
      keyNotFound: 'No memory entry contains "{{oldText}}"',
      keyAmbiguous: '"{{oldText}}" matches {{count}} entries; provide a longer unique substring',
      replaceOverLimit:
        'The replacement would exceed the {{limit}} byte capacity limit; remove or merge some entries first',
      userOverLimit:
        'USER hot memory is over capacity (limit {{limit}} bytes) and has no low-priority entries to consolidate. Remove or merge some memories first.',
      unknownAction: 'Unknown action: {{action}}',

      archiveHookMissing: 'No archive hook is configured',
      nothingToArchive: 'No memory entries can be archived',
      hookArchivedNothing: 'The archive hook did not archive any entry',

      categoryInvalid: 'Category must be one of {{values}}',
      sourceInvalid: 'Source must be one of {{values}}',
      relationTypeInvalid: 'Relation type must be one of {{values}}',
      selfRelation: 'A memory cannot be linked to itself',
      insightExists:
        'That memory already exists (identical content); call forget on the old entry first to update it',
      insightNotFound: 'Memory {{id}} not found (it may already be deleted)',

      spaceNotActivated:
        'These Memory Spaces are inactive or missing and cannot be read: {{spaces}}',
      noActiveSpace: 'No active Memory Space; create or activate one first',
      spaceNotFound: 'Memory Space not found: {{id}}',
      targetSpaceNotFound: 'Target Memory Space not found: {{id}}',

      documentTooLarge: 'A single document exceeds the {{limit}} byte limit',
      documentCapacityExceeded:
        'Not enough document capacity: the active total limit is {{limit}} bytes (current {{current}}, needed {{needed}}). Archive some documents first.',
      documentCapacityExceededOnUpdate:
        'Not enough document capacity: the update would exceed the active total limit; archive some documents first',
      documentNotFound: 'Document not found: {{id}}',
      documentArchived: 'Document {{id}} is archived and cannot be updated (recreate it first)',
      documentNotActive: 'Document {{id}} is not in active status'
    },

    hint: {
      noMatchInActiveSpaces: 'No matching content found in active Memory Spaces'
    }
  }
}
