import { getMainLanguage } from './index'

/** Result copy for the document / knowledge base / graph tools (manage_materials); follows the UI language. */
export const zhCNDocsToolTexts = {
  /** List separator between documents (Chinese enumeration comma / English comma) */
  listSeparator: '、',

  // ----- Documents -----
  docs: {
    searchCount_one: '共 {{count}} 条',
    searchCount_other: '共 {{count}} 条',
    searchHeader: '**搜索 "{{query}}"**（{{count}}）\n',
    searchEmpty: '没有找到匹配 "{{query}}" 的文档。',
    searchPage: '第 {{page}}/{{pages}} 页（用 page 参数翻页）',
    notFound: '未找到 ID 为 {{docId}} 的文档。',
    noContent: '文档 "{{title}}" 没有内容。',
    noContentRevision: '文档 "{{title}}" 没有内容（修订 {{revision}}，共 {{lineCount}} 行）。',
    noHeadings: '文档 "{{title}}" 没有标题结构。',
    headingNotFound: '未找到标题 ID "{{headingId}}"。可用标题：{{headings}}',
    headingAndRange:
      'headingId 不能与 startLine/endLine 同时使用：读整节用 headingId，读行区间用 startLine/endLine。',
    tagsLabel: '标签：{{tags}}',
    summaryLabel: '摘要：{{summary}}',
    hasImage: '有封面图片',
    tocCount_one: '共 {{count}} 个标题',
    tocCount_other: '共 {{count}} 个标题',
    tocHeader: '**{{title}}** 的目录结构（{{count}}）\n',
    tocLine: '{{indent}}[{{headingId}}] {{hashes}} {{title}}（第 {{line}} 行）',
    getHeader: '**{{title}}** [{{docId}}]',
    getMeta: '修订 {{revision}} · 共 {{lineCount}} 行',
    getRange: '第 {{startLine}}–{{endLine}} 行',
    getTruncated: '\n（输出已截断到第 {{lastLine}} 行；用 startLine={{nextLine}} 继续读取）',
    findHeader:
      '**在文档 [{{docId}}] "{{title}}" 中查找 "{{query}}"**（{{count}} · 修订 {{revision}}）',
    findCount_one: '共 {{count}} 处',
    findCount_other: '共 {{count}} 处',
    findEmpty: '未在文档 [{{docId}}] "{{title}}" 中找到 "{{query}}"（修订 {{revision}}）。',
    findMatch: '  第 {{line}} 行 第 {{column}}–{{endColumn}} 列：{{text}}',
    findMatchMultiLine:
      '  第 {{line}} 行 第 {{column}} 列 – 第 {{endLine}} 行 第 {{endColumn}} 列：{{text}}',
    findContext: '  上下文：\n{{snippet}}',
    findTruncated: '（仅显示前 {{shown}} 处，共 {{total}} 处；可用 maxMatches 调整）',
    created:
      '文档创建成功！ID: {{id}}, 标题: "{{title}}"，修订 {{revision}}。' +
      '创建后可将其归档到知识库目录中（使用 kb.archive 命令）。',
    noFieldsToUpdate: '没有需要更新的字段。',
    updated: '文档 [{{docId}}] "{{title}}" 更新成功（修订 {{revision}}）。',
    deleted: '文档 [{{docId}}] "{{title}}" 已彻底删除。',
    missingParam: '缺少参数：{{param}}。',
    titleRequired: '标题不能为空。',
    noChange: '文档 [{{docId}}] "{{title}}" 内容未变化（修订 {{revision}}）。',
    dryRunDone:
      '预览（未写入）：文档 [{{docId}}] "{{title}}" 将变更：第 {{startLine}} 行起，' +
      '-{{removed}} / +{{added}} 行（共 {{total}} 行）。',
    editDone:
      '文档 [{{docId}}] "{{title}}" 已更新：第 {{startLine}} 行起，' +
      '-{{removed}} / +{{added}} 行（共 {{total}} 行，修订 {{revision}}）。',
    changePreview:
      '变更预览：\n- 旧（第 {{oldStart}} 行起）：\n{{oldText}}\n+ 新（第 {{newStart}} 行起）：\n{{newText}}',
    revisionMismatch:
      '文档 [{{docId}}] 已被其他操作修改（读取时修订 {{expected}}，当前 {{actual}}）。请重新读取后再编辑。',
    patchEmpty: '没有提供任何编辑（edits 为空）。',
    patchEditFailed: '第 {{index}} 处编辑失败：{{message}}',
    editErrors: {
      lineOutOfRange: '行号 {{line}} 超出范围（文档共 {{lineCount}} 行）。',
      rangeOutOfRange: '行范围 {{startLine}}–{{endLine}} 无效（文档共 {{lineCount}} 行）。',
      columnOutOfRange:
        '第 {{line}} 行长度为 {{length}}，列范围 {{startColumn}}–{{endColumn}} 无效。',
      expectedOldLines:
        '第 {{startLine}}–{{endLine}} 行的内容与 expectedOld 不一致。当前内容：\n{{actual}}',
      expectedOldRange:
        '第 {{line}} 行第 {{startColumn}}–{{endColumn}} 列的内容与 expectedOld 不一致。当前内容：{{actual}}',
      emptyQuery: '查询/待替换文本不能为空。',
      noMatch: '未找到 "{{query}}"。',
      ambiguousMatch: '找到 {{count}} 处 "{{query}}"；请指定 occurrence（第几处）或 all=true。',
      occurrenceOutOfRange: 'occurrence={{occurrence}} 超出范围（共 {{count}} 处）。',
      invalidRegex: '正则表达式无效：{{message}}',
      emptyEdit: '编辑内容为空。',
      missingNewText: '编辑缺少 newText（{{type}}）；如需删除请显式传空串 ""。',
      unknownEditType: '未知编辑类型：{{type}}',
      failed: '编辑失败：{{message}}'
    },
    unknownCommand: '未知命令：{{command}}。'
  },

  // ----- Knowledge bases -----
  wikis: {
    listEmpty: '还没有创建任何知识库。',
    listHeader: '**知识库列表**（共 {{count}} 个）\n',
    listPage: '（第 {{page}}/{{pages}} 页，共 {{total}} 个知识库）',
    tagsLabel: '标签：{{tags}}',
    descriptionLabel: '描述：{{summary}}',
    docCountLabel: '文档数：{{count}}',
    notFound: '未找到 ID 为 {{wikiId}} 的知识库。',
    wikiTagsLabel: '标签：{{tags}}',
    wikiDescriptionLabel: '描述：{{summary}}',
    wikiHasImage: '有封面图片',
    docTotalLabel: '文档总数：{{count}}',
    createdAtLabel: '创建时间：{{createdAt}}',
    updatedAtLabel: '更新时间：{{updatedAt}}',
    directoryCount_one: '共 {{count}} 个',
    directoryCount_other: '共 {{count}} 个',
    directoriesHeader: '**{{title}}** 的目录结构（{{count}}）\n',
    directoriesEmpty: '知识库 "{{title}}" 下还没有目录。',
    directoryDocCount: '（{{count}} 篇）',
    directoryEmpty: '（空）',
    directoryDocsEmpty: '该目录下还没有文档。',
    directoryDocsHeader: '**目录文档列表**（共 {{count}} 篇）\n',
    docTagsLabel: '标签：{{tags}}',
    docDescriptionLabel: '描述：{{summary}}',
    created: '知识库创建成功！ID: {{id}}, 标题: "{{title}}"',
    noFieldsToUpdate: '没有需要更新的字段。',
    updated: '知识库 [{{wikiId}}] "{{title}}" 更新成功。',
    deleted: '知识库 [{{wikiId}}] "{{title}}" 已删除。',
    parentNotFound: '父目录不存在或不属于知识库 [{{wikiId}}]，创建已取消。',
    directoryCreated: '目录创建成功！ID: {{id}}, 名称: "{{name}}", 所属知识库: "{{wikiTitle}}"',
    directoryUpdated: '目录 [{{directoryId}}] 已更新为 "{{name}}"。',
    directoryDeleted: '目录 [{{directoryId}}] 已删除。',
    archivedDoc: '  文档 [{{docId}}] 归档成功',
    archiveFailedDoc: '  文档 [{{docId}}] 归档失败（可能已存在）',
    archiveEmpty: '没有提供要归档的文档 ID。',
    archiveDone: '归档完成：\n{{results}}',
    docRemoved: '文档 [{{docId}}] 已从目录 [{{directoryId}}] 移除。',
    removeFailed: '移除失败：文档 [{{docId}}] 不在目录 [{{directoryId}}] 中。',
    directoryNotFound: '目录不存在：{{ids}}。',
    moveCrossWiki: '源目录与目标目录不属于同一个知识库，不能移动。',
    moveNotInSource: '文档 [{{docId}}] 不在源目录 [{{fromDirectoryId}}] 中。',
    moveFailed:
      '移动失败：文档 [{{docId}}] 无法归档到目录 [{{toDirectoryId}}]（可能已存在）；源目录关联已保留。',
    moved: '文档 [{{docId}}] 已从目录 [{{fromDirectoryId}}] 移动到 [{{toDirectoryId}}]。',
    unknownCommand: '未知命令：{{command}}。'
  },

  // ----- Knowledge graph -----
  graph: {
    searchHeader: '**知识图谱搜索 "{{query}}"**\n',
    searchSummary: '{{count}} · {{wikis}} 个知识库命中',
    searchEmpty: '未在知识图谱中找到与 "{{query}}" 相关的实体。',
    wikiLabel: '  Wiki [{{wikiId}}]：',
    wikiTitleLabel: '  Wiki [{{wikiId}}] {{title}}：',
    aliasSuffix: '（别名：{{aliases}}）',
    confidenceSuffix: '（置信度 {{percent}}%）',
    confidenceValue: '置信度 {{percent}}%',
    entityCount_one: '共 {{count}} 个实体',
    entityCount_other: '共 {{count}} 个实体',
    descriptionLabel: '描述：',
    sourceDocsLabel: '来源文档：{{docs}}',
    entityNotFound: '未找到 ID 为 {{entityId}} 的图谱实体。',
    entityHeader: '**{{name}}** [{{entityId}}]（知识库 [{{wikiId}}] {{wikiTitle}}）',
    entityMeta: '类型：{{type}} · {{confidence}}',
    aliasLine: '别名：{{aliases}}',
    propertiesLine: '属性：{{properties}}',
    descriptionTitle: '**描述**',
    noRelations: '该实体还没有关系。',
    relationsHeader: '**关系**（共 {{count}} 条）',
    relationLine: '  {{arrow}} {{type}} {{peer}}{{description}}',
    relationDescription: '：{{description}}',
    relationsTruncated: '（仅显示前 {{shown}} 条，共 {{total}} 条；可用 limit 调整）'
  }
}

export const enUSDocsToolTexts: typeof zhCNDocsToolTexts = {
  listSeparator: ', ',

  docs: {
    searchCount_one: '{{count}} result',
    searchCount_other: '{{count}} results',
    searchHeader: '**Search "{{query}}"** ({{count}})\n',
    searchEmpty: 'No documents match "{{query}}".',
    searchPage: 'Page {{page}}/{{pages}} (use the page parameter to paginate)',
    notFound: 'Document {{docId}} not found.',
    noContent: 'Document "{{title}}" has no content.',
    noContentRevision:
      'Document "{{title}}" has no content (revision {{revision}}, {{lineCount}} lines).',
    noHeadings: 'Document "{{title}}" has no heading structure.',
    headingNotFound: 'Heading ID "{{headingId}}" not found. Available headings: {{headings}}',
    headingAndRange:
      'headingId cannot be combined with startLine/endLine: use headingId for a section or startLine/endLine for a line range.',
    tagsLabel: 'Tags: {{tags}}',
    summaryLabel: 'Summary: {{summary}}',
    hasImage: 'Has a cover image',
    tocCount_one: '{{count}} heading',
    tocCount_other: '{{count}} headings',
    tocHeader: "**{{title}}**'s table of contents ({{count}})\n",
    tocLine: '{{indent}}[{{headingId}}] {{hashes}} {{title}} (line {{line}})',
    getHeader: '**{{title}}** [{{docId}}]',
    getMeta: 'revision {{revision}} · {{lineCount}} lines',
    getRange: 'lines {{startLine}}–{{endLine}}',
    getTruncated: '\n(output truncated at line {{lastLine}}; continue with startLine={{nextLine}})',
    findHeader:
      '**Search "{{query}}" in document [{{docId}}] "{{title}}"** ({{count}} · revision {{revision}})',
    findCount_one: '{{count}} match',
    findCount_other: '{{count}} matches',
    findEmpty: 'No "{{query}}" found in document [{{docId}}] "{{title}}" (revision {{revision}}).',
    findMatch: '  line {{line}}, columns {{column}}–{{endColumn}}: {{text}}',
    findMatchMultiLine:
      '  line {{line}} column {{column}} – line {{endLine}} column {{endColumn}}: {{text}}',
    findContext: '  context:\n{{snippet}}',
    findTruncated: '(showing the first {{shown}} of {{total}} matches; adjust maxMatches)',
    created:
      'Document created! ID: {{id}}, title: "{{title}}", revision {{revision}}. ' +
      'You can archive it into a wiki directory afterwards (use kb.archive).',
    noFieldsToUpdate: 'No fields to update.',
    updated: 'Document [{{docId}}] "{{title}}" updated (revision {{revision}}).',
    deleted: 'Document [{{docId}}] "{{title}}" permanently deleted.',
    missingParam: 'Missing parameter: {{param}}.',
    titleRequired: 'Title cannot be empty.',
    noChange: 'Document [{{docId}}] "{{title}}" is unchanged (revision {{revision}}).',
    dryRunDone:
      'Preview (not written): document [{{docId}}] "{{title}}" would change at line {{startLine}}, ' +
      '-{{removed}} / +{{added}} lines ({{total}} lines total).',
    editDone:
      'Document [{{docId}}] "{{title}}" updated at line {{startLine}}, ' +
      '-{{removed}} / +{{added}} lines ({{total}} lines total, revision {{revision}}).',
    changePreview:
      'Change preview:\n- old (from line {{oldStart}}):\n{{oldText}}\n+ new (from line {{newStart}}):\n{{newText}}',
    revisionMismatch:
      'Document [{{docId}}] was changed elsewhere (expected revision {{expected}}, current {{actual}}). Re-read it before editing.',
    patchEmpty: 'No edits were provided (edits is empty).',
    patchEditFailed: 'Edit #{{index}} failed: {{message}}',
    editErrors: {
      lineOutOfRange: 'Line {{line}} is out of range (document has {{lineCount}} lines).',
      rangeOutOfRange:
        'Line range {{startLine}}–{{endLine}} is invalid (document has {{lineCount}} lines).',
      columnOutOfRange:
        'Line {{line}} has {{length}} characters; column range {{startColumn}}–{{endColumn}} is invalid.',
      expectedOldLines:
        'Lines {{startLine}}–{{endLine}} do not match expectedOld. Current content:\n{{actual}}',
      expectedOldRange:
        'Line {{line}} columns {{startColumn}}–{{endColumn}} do not match expectedOld. Current content: {{actual}}',
      emptyQuery: 'The query/text to replace cannot be empty.',
      noMatch: 'No match for "{{query}}".',
      ambiguousMatch:
        'Found {{count}} matches for "{{query}}"; specify occurrence (which match) or all=true.',
      occurrenceOutOfRange: 'occurrence={{occurrence}} is out of range ({{count}} matches).',
      invalidRegex: 'Invalid regular expression: {{message}}',
      emptyEdit: 'The edit content is empty.',
      missingNewText:
        'The edit is missing newText ({{type}}); pass an explicit empty string "" to delete.',
      unknownEditType: 'Unknown edit type: {{type}}',
      failed: 'Edit failed: {{message}}'
    },
    unknownCommand: 'Unknown command: {{command}}.'
  },

  wikis: {
    listEmpty: 'No wikis have been created yet.',
    listHeader: '**Knowledge bases** ({{count}} total)\n',
    listPage: '(page {{page}}/{{pages}}, {{total}} knowledge bases)',
    tagsLabel: 'Tags: {{tags}}',
    descriptionLabel: 'Description: {{summary}}',
    docCountLabel: 'Documents: {{count}}',
    notFound: 'Wiki {{wikiId}} not found.',
    wikiTagsLabel: 'Tags: {{tags}}',
    wikiDescriptionLabel: 'Description: {{summary}}',
    wikiHasImage: 'Has a cover image',
    docTotalLabel: 'Total documents: {{count}}',
    createdAtLabel: 'Created: {{createdAt}}',
    updatedAtLabel: 'Updated: {{updatedAt}}',
    directoryCount_one: '{{count}} directory',
    directoryCount_other: '{{count}} directories',
    directoriesHeader: "**{{title}}**'s directory tree ({{count}})\n",
    directoriesEmpty: 'Wiki "{{title}}" has no directories yet.',
    directoryDocCount: '({{count}} docs)',
    directoryEmpty: '(empty)',
    directoryDocsEmpty: 'This directory has no documents yet.',
    directoryDocsHeader: '**Directory documents** ({{count}} total)\n',
    docTagsLabel: 'Tags: {{tags}}',
    docDescriptionLabel: 'Description: {{summary}}',
    created: 'Wiki created! ID: {{id}}, title: "{{title}}"',
    noFieldsToUpdate: 'No fields to update.',
    updated: 'Wiki [{{wikiId}}] "{{title}}" updated.',
    deleted: 'Wiki [{{wikiId}}] "{{title}}" deleted.',
    parentNotFound:
      'The parent directory does not exist or does not belong to wiki [{{wikiId}}]; creation cancelled.',
    directoryCreated: 'Directory created! ID: {{id}}, name: "{{name}}", wiki: "{{wikiTitle}}"',
    directoryUpdated: 'Directory [{{directoryId}}] renamed to "{{name}}".',
    directoryDeleted: 'Directory [{{directoryId}}] deleted.',
    archivedDoc: '  Document [{{docId}}] archived',
    archiveFailedDoc: '  Document [{{docId}}] failed to archive (it may already be there)',
    archiveEmpty: 'No document IDs were provided to archive.',
    archiveDone: 'Archive complete:\n{{results}}',
    docRemoved: 'Document [{{docId}}] removed from directory [{{directoryId}}].',
    removeFailed: 'Remove failed: document [{{docId}}] is not in directory [{{directoryId}}].',
    directoryNotFound: 'Directory not found: {{ids}}.',
    moveCrossWiki: 'Source and target directories belong to different knowledge bases.',
    moveNotInSource: 'Document [{{docId}}] is not in source directory [{{fromDirectoryId}}].',
    moveFailed:
      'Move failed: document [{{docId}}] could not be archived into directory [{{toDirectoryId}}] (it may already exist); the source link was kept.',
    moved:
      'Document [{{docId}}] moved from directory [{{fromDirectoryId}}] to [{{toDirectoryId}}].',
    unknownCommand: 'Unknown command: {{command}}.'
  },

  graph: {
    searchHeader: '**Knowledge graph search "{{query}}"**\n',
    searchSummary: '{{count}} · {{wikis}} knowledge bases matched',
    searchEmpty: 'No entities related to "{{query}}" were found in the knowledge graph.',
    wikiLabel: '  Wiki [{{wikiId}}]:',
    wikiTitleLabel: '  Wiki [{{wikiId}}] {{title}}:',
    aliasSuffix: ' (aliases: {{aliases}})',
    confidenceSuffix: ' (confidence {{percent}}%)',
    confidenceValue: 'confidence {{percent}}%',
    entityCount_one: '{{count}} entity',
    entityCount_other: '{{count}} entities',
    descriptionLabel: 'Description: ',
    sourceDocsLabel: 'Source documents: {{docs}}',
    entityNotFound: 'Graph entity {{entityId}} not found.',
    entityHeader: '**{{name}}** [{{entityId}}] (wiki [{{wikiId}}] {{wikiTitle}})',
    entityMeta: 'Type: {{type}} · {{confidence}}',
    aliasLine: 'Aliases: {{aliases}}',
    propertiesLine: 'Properties: {{properties}}',
    descriptionTitle: '**Description**',
    noRelations: 'This entity has no relations yet.',
    relationsHeader: '**Relations** ({{count}} total)',
    relationLine: '  {{arrow}} {{type}} {{peer}}{{description}}',
    relationDescription: ': {{description}}',
    relationsTruncated: '(showing the first {{shown}} of {{total}}; adjust limit)'
  }
}

export function getDocsToolTexts(): typeof zhCNDocsToolTexts {
  return getMainLanguage() === 'en-US' ? enUSDocsToolTexts : zhCNDocsToolTexts
}
