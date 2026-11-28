import { getMainLanguage } from './index'

/**
 * Result texts for the filesystem tools (fs-backend), spill locators, the ask tool and
 * compaction pruning.
 *
 * **Rendered on the tool-call cards in the chat** (the model reads the same text), so they must
 * follow the UI language.
 * Split of work with `tool-results.ts`: that file covers the mnemon tool group, this one the
 * runtime tools and intermediate layers.
 *
 * Chinese is the source language; `enUSFsToolTexts` is constrained by `typeof zhCNFsToolTexts`,
 * so a missing or extra key is a compile-time error.
 * Interpolation always uses `{{name}}` + `mainFormat` (Chinese and English phrase things
 * differently, so each entry decides its own placeholder order).
 *
 * Note: only user-facing wording belongs here. Tool `name` / `description` / `.describe()` /
 * schema, field names, spill filenames, virtual paths and the `ASK_ABORTED` marker are protocol
 * or data, not text.
 */
export const zhCNFsToolTexts = {
  path: {
    /** The virtual path is empty */
    empty: '路径不能为空',
    /** A Windows absolute path was rejected (no entry point for the model to scan drives) */
    absolute: '路径 "{{path}}" 是绝对路径，请使用虚拟路径（如 /uploads/xxx）',
    /** ../ escaped the mount root directory */
    escapesMount: '路径 "{{path}}" 越出挂载根目录',
    /** No mount matches this virtual path */
    notMounted: '路径 "{{path}}" 未挂载到任何虚拟目录'
  },

  read: {
    notFile: '路径不是文件: {{path}}',
    failed: '读取文件失败: {{message}}',
    /** Header note when reading a line range by offset/limit */
    lineRange: '（第 {{start}}-{{end}} 行 / 共 {{total}} 行）\n',
    /** Same as above, but the file exceeds the in-memory guard limit and only the first 2M characters are kept */
    lineRangeOversized: '（第 {{start}}-{{end}} 行 / 共 {{total}} 行，文件超大仅索引前 2M 字符）\n',
    /** Truncated at the inline limit (read does not spill; large files are read on demand) */
    truncated:
      '（文件过长，共 {{total}} 字符，已省略中间内容。可用 offset/limit 参数按行读取任意片段，或用 grep 检索关键字。）'
  },

  readImage: {
    notFile: '路径不是文件: {{path}}',
    tooLarge: '图片过大（{{bytes}} 字节，上限 {{limit}} 字节），请压缩或裁剪后再读取。',
    unsupported: '不支持的图片格式（仅支持 PNG / JPEG / WebP / GIF）: {{path}}',
    failed: '读取图片失败: {{message}}',
    ok: '已读取图片 {{path}}（{{mime}}，{{width}}×{{height}}，{{bytes}} 字节）。图片已附在本工具结果之后，可直接查看。',
    okNoDimensions:
      '已读取图片 {{path}}（{{mime}}，{{bytes}} 字节）。图片已附在本工具结果之后，可直接查看。',
    /** Extra note when normalization happened (the original file is untouched) */
    normalizedNote: '（已按上下文预算缩放/重编码；原文件未改动。）',
    /** Vision gate: the model profile for the current route does not declare image input */
    modelUnsupported:
      '当前模型不支持图片输入（模型档案未声明 supports_image_input），read_image 已拒绝执行。请切换到支持视觉的模型，或先在模型设置里为该模型补充图片输入能力。',
    /** Header of the image message appended to the model context (model-facing text) */
    attached: '工具 {{tool}} 读取的图片：{{path}}'
  },

  write: {
    written: '已写入 {{path}}（{{bytes}} 字节）',
    failed: '写入文件失败: {{message}}'
  },

  edit: {
    /** An empty old_string would make the non-overlapping count loop spin forever, so the entry point rejects it explicitly */
    emptyOldString: 'old_string 不能为空：请提供文件中真实存在的原文片段作为查找目标。',
    noMatch:
      '未找到匹配内容，未做任何修改。请检查 old_string 是否与文件内容完全一致（包括空白与换行）。',
    /* Occurrence and replacement counts go through mainPlural: both Chinese forms are identical, English uses 1 occurrence / n occurrences */
    occurrences_one:
      'old_string 在文件中出现 {{count}} 次。请提供更长的唯一上下文，或将 replace_all 设为 true。',
    occurrences_other:
      'old_string 在文件中出现 {{count}} 次。请提供更长的唯一上下文，或将 replace_all 设为 true。',
    updated_one: '已更新 {{path}}：替换了 {{count}} 处。',
    updated_other: '已更新 {{path}}：替换了 {{count}} 处。',
    failed: '编辑文件失败: {{message}}'
  },

  applyPatch: {
    /** Patch applied: {{summary}} is the per-file summary lines */
    applied: '补丁已应用（{{files}} 个文件）：\n{{summary}}',    parseFailed:
      '补丁格式错误（{{code}}）。请用 "*** Begin Patch" / "*** End Patch" 包裹，更新块的行以空格（上下文）、"-"（删除）或 "+"（新增）开头。',
    addExists: '文件已存在，无法新增（如要修改请用 Update File）: {{path}}',
    deleteMissing: '文件不存在，无法删除: {{path}}',
    updateMissing: '文件不存在，无法更新: {{path}}',
    hunkNotFound:
      '无法在 {{path}} 中找到第 {{hunk}} 个更新块的上下文，未做任何修改。请先 read_file 确认文件当前内容（空白与换行必须完全一致）。',
    emptyHunk: '{{path}} 的第 {{hunk}} 个更新块没有上下文或删除行。',
    failed: '应用补丁失败: {{message}}',
    summaryAdd: 'A {{path}}（{{lines}} 行）',
    summaryDelete: 'D {{path}}',
    summaryUpdate: 'M {{path}}（+{{added}} −{{removed}}）'
  },

  /** str_replace_editor: view / create / str_replace / insert */
  strEditor: {
    missing: '文件不存在: {{path}}',
    exists: '文件已存在，无法创建: {{path}}',
    created: '已创建 {{path}}（{{lines}} 行）。',
    viewEmpty: '（空文件）',
    notFound: '未找到 old_str，未做任何修改。请先用 view 确认文件当前内容（空白与换行必须完全一致）。',
    notUnique: 'old_str 在文件中出现多次，未做任何修改。请提供更长、唯一的上下文。',
    invalidLine: 'insert_line 超出范围（允许 0-{{max}}）。',
    replaced: '已替换 {{path}} 中的 1 处（文件共 {{total}} 行）。',
    inserted: '已在 {{path}} 的第 {{line}} 行之后插入内容（文件共 {{total}} 行）。',
    failed: 'str_replace_editor 失败: {{message}}'
  },

  /** read_document: extract text from docx / xlsx / pptx / plain text */
  readDocument: {
    unsupported:
      '不支持的文档类型: {{path}}（支持 .docx / .xlsx / .pptx / .csv / .tsv / .md / .txt / .json / .yaml；.pdf 暂不支持）',
    empty: '文档没有可提取的文本: {{path}}',
    tooLarge: '文档过大（{{bytes}} 字节，上限 {{limit}} 字节）: {{path}}',
    failed: '读取文档失败: {{message}}',
    /** Success header: kind and byte size; {{meta}} is an optional structured summary line */
    header: '文档: {{path}}（{{kind}}，{{bytes}} 字节）{{meta}}',
    truncated: '\n\n（文档共 {{total}} 字符，已截断；可只导出需要的部分后再读。）'
  },

  ls: {
    failed: '列出目录失败: {{message}}'
  },

  glob: {
    failed: '搜索失败: {{message}}'
  },

  exec: {
    /** Hard output cap truncation for execute */
    truncated: '（输出过长，已截断）',
    /** The command timed out and was terminated */
    timedOut: '（命令超时，已终止）',
    /** No sandbox backend is available on this platform: the command was **not run** (fail closed) */
    sandboxUnavailable: '沙箱不可用，命令未执行：{{reason}}',
    /** The sandbox backend itself failed to start: the command was **not run** (distinct from "command failed") */
    sandboxRunnerFailed: '沙箱后端启动失败，命令未执行：{{detail}}',
    /** The OS denied this operation at the sandbox layer (e.g. writes outside the allowed roots) */
    sandboxDenied: '命令试图做沙箱允许范围之外的事（{{mode}} 模式），已被操作系统拒绝：',

    /* ── Background execution (run_in_background) ── */
    /** Start receipt: tells the model the task keeps running in the background, how to read output and how to stop it */
    backgroundStarted:
      '命令已在后台启动（job_id={{id}}）。你可以继续处理或总结本轮，不必等它结束；用 job_output(job_id="{{id}}") 增量读取输出，用 job_kill(job_id="{{id}}") 终止它。',
    /** Reject background execution when there is no topic context (subagent path) */
    backgroundNoTopic:
      '后台运行只在主代理的会话中可用（缺少话题上下文）。请改为前台执行，或让主代理启动这个任务。',
    /** Line appended once background output exceeds the retention limit */
    backgroundTruncated: '（后台输出超过留存上限，后续输出已丢弃）',
    /** Terminal line appended when the command exits (both the model and the UI can see the exit code) */
    backgroundExitCode: '（命令已退出，退出码 {{code}}）',
    /** The background task itself failed (an error thrown while starting or running, not a non-zero command exit) */
    backgroundFailed: '后台任务执行失败：{{message}}'
  },

  output: {
    /** Hard output cap truncation applied by formatOutput */
    truncated: '（输出过大，已截断，共 {{total}} 字符）'
  },

  spill: {
    /** Middle segment omitted from the inline preview of an oversized result */
    middleOmitted: '……（中间 {{omitted}} 字符已省略）……',
    /** Spill locator plus retrieval guidance (read_file with offset/limit, or grep to locate content) */
    locator:
      '（输出共 {{total}} 字符，超出内联上限，完整结果已保存至 {{virtualPath}}。可用 read_file 加 offset/limit 按行读取该文件的片段，或用 grep 在 / 下检索关键字定位具体内容。）'
  },

  ask: {
    /**
     * The question was aborted by this turn's cancellation signal. `ASK_ABORTED` is an identifier
     * string that must be kept verbatim in both the Chinese and English trees (the caller checks
     * `err.name === 'AskAbortedError'`, not the message).
     */
    aborted: '提问已取消（ASK_ABORTED）',
    /** Cancellation note the tool layer returns to the model */
    abortedDetail: '提问已取消（ASK_ABORTED）：用户取消了本轮对话。',
    failed: '提问失败: {{message}}'
  },

  compaction: {
    /** The summarizer returned only whitespace */
    summaryEmpty: '摘要输出为空',
    /** Pruning marker for tool results replayed into history (the full content stays in the conversation record) */
    toolResultPruned: '……（{{omitted}} 字符已裁剪，完整内容保留在会话记录中）……',
    /** Placeholder left after an old tool result is cleared: keeps "what was called" and drops the raw bytes (the structure must stay) */
    observationMasked:
      '[旧工具结果已清理] {{call}}（callId={{callId}}）。如需原始内容，请重新读取该文件或重跑该命令。',
    /** Heading for files re-injected after compaction (their content follows) */
    restoredContext: '以下是你压缩前读过/改过的文件（自动恢复，供继续工作参考）：',
    /** Heading for the todo list re-injected after compaction */
    restoredTodos: '当前待办清单：'
  },

  /**
   * Sandbox (permission mode) texts.
   *
   * The `[sandbox: ...]` marker itself is a **protocol string** and does not live here; its source
   * of truth is runtime/permission.ts (the model recognizes denials by the marker, and tooling
   * asserts on it). Only the body text that follows the UI language belongs here.
   */
  sandbox: {
    reason: {
      /** Writing a file in read-only mode */
      readOnlyWrite: '当前权限是「仅可查看」：写文件需要你临时提权后才能执行。',
      /** A risky command in read-only mode */
      readOnlyExec: '当前权限是「仅可查看」：这条命令会改动系统，已被拦截（{{evidence}}）。',
      /** An external tool in read-only mode (its read-only status cannot be verified) */
      readOnlyExternal: '当前权限是「仅可查看」：无法确认这个外部工具（MCP / 插件）是否只读。',
      /** The command references a path outside the workspace */
      outsidePath: '命令里出现工作区以外的路径：{{evidence}}',
      /** The command contains a risky operation */
      riskyCommand: '命令里出现危险操作：{{evidence}}',
      /** Plugin workshop tools build or run model-written code in the main process */
      codeExec:
        '这个插件工坊工具会构建或在主进程执行模型写的代码，需要你确认后才能继续。'
    },
    escalation: {
      invalidMode:
        '升权参数不合法：sandbox_permissions 只能是 read-only / workspace-write / danger-full-access 之一。',
      invalidJustification: '升权必须同时给出 justification（一句话说明为什么要越过沙箱）。',
      notWider: '升权目标必须比当前档位更宽：read-only → workspace-write → danger-full-access。',
      notPreviouslyDenied:
        '只有刚被沙箱拒绝过的同一次调用才能申请升权：请先原样重试拿到拒绝结果，再带上 sandbox_permissions 与 justification。'
    }
  }
}

export const enUSFsToolTexts: typeof zhCNFsToolTexts = {
  path: {
    empty: 'Path must not be empty',
    absolute: 'Path "{{path}}" is an absolute path; use a virtual path such as /uploads/xxx',
    escapesMount: 'Path "{{path}}" escapes the mount root directory',
    notMounted: 'Path "{{path}}" is not mounted under any virtual directory'
  },

  read: {
    notFile: 'Not a file: {{path}}',
    failed: 'Failed to read the file: {{message}}',
    lineRange: '(lines {{start}}–{{end}} of {{total}})\n',
    lineRangeOversized:
      '(lines {{start}}–{{end}} of {{total}}; this file exceeds the 2M character index limit, so only its first 2M characters are indexed)\n',
    truncated:
      '(file too long: {{total}} characters, the middle has been omitted. Use offset/limit to read any line range, or grep to search for keywords.)'
  },

  readImage: {
    notFile: 'Not a file: {{path}}',
    tooLarge: 'The image is too large ({{bytes}} bytes, limit {{limit}} bytes). Compress or crop it before reading.',
    unsupported: 'Unsupported image format (only PNG / JPEG / WebP / GIF are supported): {{path}}',
    failed: 'Failed to read the image: {{message}}',
    ok: 'Read image {{path}} ({{mime}}, {{width}}×{{height}}, {{bytes}} bytes). The image is attached right after this tool result and can be viewed directly.',
    okNoDimensions:
      'Read image {{path}} ({{mime}}, {{bytes}} bytes). The image is attached right after this tool result and can be viewed directly.',
    normalizedNote: ' (downscaled/re-encoded for the context budget; the original file is untouched.)',
    modelUnsupported:
      'The current model does not accept image input (its model profile does not declare supports_image_input), so read_image refused to run. Switch to a vision-capable model, or add image input to this model in the model settings first.',
    attached: 'Image read by tool {{tool}}: {{path}}'
  },

  write: {
    written: 'Wrote {{path}} ({{bytes}} bytes)',
    failed: 'Failed to write the file: {{message}}'
  },

  edit: {
    emptyOldString:
      'old_string must not be empty: provide an exact excerpt that really exists in the file as the search target.',
    noMatch:
      'No match found, so nothing was changed. Check that old_string matches the file content exactly (including whitespace and line breaks).',
    occurrences_one:
      'old_string occurs {{count}} time in the file. Provide a longer unique context, or set replace_all to true.',
    occurrences_other:
      'old_string occurs {{count}} times in the file. Provide a longer unique context, or set replace_all to true.',
    updated_one: 'Updated {{path}}: {{count}} replacement made.',
    updated_other: 'Updated {{path}}: {{count}} replacements made.',
    failed: 'Failed to edit the file: {{message}}'
  },

  applyPatch: {
    applied: 'Patch applied ({{files}} files):\n{{summary}}',
    parseFailed:
      'Malformed patch ({{code}}). Wrap it in "*** Begin Patch" / "*** End Patch"; hunk lines start with a space (context), "-" (removed) or "+" (added).',
    addExists: 'The file already exists, so it cannot be added (use Update File to modify it): {{path}}',
    deleteMissing: 'The file does not exist, so it cannot be deleted: {{path}}',
    updateMissing: 'The file does not exist, so it cannot be updated: {{path}}',
    hunkNotFound:
      'Could not find the context of update hunk #{{hunk}} in {{path}}; nothing was changed. Read the file first and match whitespace and line breaks exactly.',
    emptyHunk: 'Hunk #{{hunk}} of {{path}} has no context or removed lines.',
    failed: 'Failed to apply the patch: {{message}}',
    summaryAdd: 'A {{path}} ({{lines}} lines)',
    summaryDelete: 'D {{path}}',
    summaryUpdate: 'M {{path}} (+{{added}} −{{removed}})'
  },

  /** str_replace_editor: view / create / str_replace / insert */
  strEditor: {
    missing: 'The file does not exist: {{path}}',
    exists: 'The file already exists and cannot be created: {{path}}',
    created: 'Created {{path}} ({{lines}} lines).',
    viewEmpty: '(empty file)',
    notFound:
      'old_str was not found, so nothing changed. Use view first and match whitespace and line breaks exactly.',
    notUnique:
      'old_str occurs more than once, so nothing changed. Provide a longer, unique context.',
    invalidLine: 'insert_line is out of range (allowed: 0-{{max}}).',
    replaced: 'Replaced 1 occurrence in {{path}} ({{total}} lines total).',
    inserted: 'Inserted content after line {{line}} of {{path}} ({{total}} lines total).',
    failed: 'str_replace_editor failed: {{message}}'
  },

  /** read_document: extract text from docx / xlsx / pptx / plain text */
  readDocument: {
    unsupported:
      'Unsupported document type: {{path}} (supports .docx / .xlsx / .pptx / .csv / .tsv / .md / .txt / .json / .yaml; .pdf is not supported yet)',
    empty: 'The document has no extractable text: {{path}}',
    tooLarge: 'The document is too large ({{bytes}} bytes, limit {{limit}} bytes): {{path}}',
    failed: 'Failed to read the document: {{message}}',
    header: 'Document: {{path}} ({{kind}}, {{bytes}} bytes){{meta}}',
    truncated:
      '\n\n(The document has {{total}} characters and was truncated; export only the needed part and read it again.)'
  },

  ls: {
    failed: 'Failed to list the directory: {{message}}'
  },

  glob: {
    failed: 'Search failed: {{message}}'
  },

  exec: {
    truncated: '(output truncated)',
    timedOut: '(command timed out and was terminated)',
    sandboxUnavailable: 'The sandbox is unavailable, so the command was NOT run: {{reason}}',
    sandboxRunnerFailed:
      'The sandbox backend failed to start, so the command was NOT run: {{detail}}',
    sandboxDenied:
      'The command tried to do something outside what the sandbox allows ({{mode}} mode) and the operating system denied it:',

    backgroundStarted:
      'The command was started in the background (job_id={{id}}). Keep processing or summarizing this turn; use job_output(job_id="{{id}}") to read its output incrementally and job_kill(job_id="{{id}}") to terminate it.',
    backgroundNoTopic:
      'Background execution is only available to the main agent (no topic context). Run the command in the foreground instead, or have the main agent start it.',
    backgroundTruncated:
      '(background output exceeded the retention limit; further output was dropped)',
    backgroundExitCode: '(the command exited with code {{code}})',
    backgroundFailed: 'The background task failed: {{message}}'
  },

  output: {
    truncated: '(output too large, truncated at {{total}} characters)'
  },

  spill: {
    middleOmitted: '……({{omitted}} characters omitted in the middle)……',
    locator:
      '(output is {{total}} characters, over the inline limit; the full result was saved to {{virtualPath}}. Use read_file with offset/limit to read a slice of that file, or grep to locate the relevant content by keyword.)'
  },

  ask: {
    aborted: 'Question cancelled (ASK_ABORTED)',
    abortedDetail:
      'Question cancelled (ASK_ABORTED): the user cancelled this turn of the conversation.',
    failed: 'Failed to ask the question: {{message}}'
  },

  compaction: {
    summaryEmpty: 'The summarizer returned an empty output',
    toolResultPruned:
      '……({{omitted}} characters pruned; the full content is kept in the conversation record)……',
    observationMasked:
      '[Old tool result cleared] {{call}} (callId={{callId}}). Re-read the file or re-run the command if you need the raw output.',
    restoredContext:
      'Files you read or edited before compaction (auto-restored as reference for continuing the work):',
    restoredTodos: 'Current todo list:'
  },

  sandbox: {
    reason: {
      readOnlyWrite:
        'Current permission is "read only": writing files needs your one-off escalation first.',
      readOnlyExec:
        'Current permission is "read only": this command would change the system, so it was blocked ({{evidence}}).',
      readOnlyExternal:
        'Current permission is "read only": this external tool (MCP / plugin) cannot be verified as read-only.',
      outsidePath: 'Command references a path outside the workspace: {{evidence}}',
      riskyCommand: 'Command contains a risky operation: {{evidence}}',
      codeExec:
        'This plugin workshop tool builds or runs code authored by the model inside the main process; it needs your approval.'
    },
    escalation: {
      invalidMode:
        'Invalid escalation argument: sandbox_permissions must be one of read-only / workspace-write / danger-full-access.',
      invalidJustification:
        'Escalation requires justification: one sentence explaining why the sandbox should be bypassed.',
      notWider:
        'The escalation target must be strictly wider than the current mode: read-only → workspace-write → danger-full-access.',
      notPreviouslyDenied:
        'Only the exact call that the sandbox just denied can request escalation: retry it unchanged first, then add sandbox_permissions and justification.'
    }
  }
}

/** Return the fs / spill / ask / compaction tool text tree for the current UI language */
export function getFsToolTexts(): typeof zhCNFsToolTexts {
  return getMainLanguage() === 'en-US' ? enUSFsToolTexts : zhCNFsToolTexts
}
