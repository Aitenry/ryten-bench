import { getMainLanguage } from './index'

/**
 * 文件系统工具（fs-backend）/ 溢出定位（spill）/ 提问工具（ask）/ 压缩裁剪（compaction）
 * 的返回文案。
 *
 * **会渲染在聊天的工具调用卡片上**（模型读到的也是同一份文本），因此必须跟随界面语言。
 * 与 `tool-results.ts` 的分工：那边是 mnemon 工具组，这边是运行时工具与中间层。
 *
 * 中文是源语言，`enUSFsToolTexts` 用 `typeof zhCNFsToolTexts` 约束，缺键/多键都是编译期错误。
 * 插值统一用 `{{name}}` + `mainFormat`（中英句式不同，占位符顺序由词条自己决定）。
 *
 * 注意：这里只放「话术」。工具 `name` / `description` / `.describe()` / schema、字段名、
 * 溢出文件名、虚拟路径、`ASK_ABORTED` 标识串都是协议或数据，不是文案。
 */
export const zhCNFsToolTexts = {
  path: {
    /** 虚拟路径为空 */
    empty: '路径不能为空',
    /** Windows 绝对路径被拒绝（不给模型扫描驱动器的入口） */
    absolute: '路径 "{{path}}" 是绝对路径，请使用虚拟路径（如 /uploads/xxx）',
    /** ../ 逃逸出挂载根目录 */
    escapesMount: '路径 "{{path}}" 越出挂载根目录',
    /** 没有任何挂载能匹配该虚拟路径 */
    notMounted: '路径 "{{path}}" 未挂载到任何虚拟目录'
  },

  read: {
    notFile: '路径不是文件: {{path}}',
    failed: '读取文件失败: {{message}}',
    /** 按 offset/limit 读行区间时的头部注记 */
    lineRange: '（第 {{start}}-{{end}} 行 / 共 {{total}} 行）\n',
    /** 同上，但文件超过内存保护上限、只保留了前 2M 字符 */
    lineRangeOversized: '（第 {{start}}-{{end}} 行 / 共 {{total}} 行，文件超大仅索引前 2M 字符）\n',
    /** 内联上限截断（read 不走溢出策略，大文件按需读取） */
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
    /** 规范化发生时的追加说明（原文件未改动） */
    normalizedNote: '（已按上下文预算缩放/重编码；原文件未改动。）',
    /** 视觉门禁：当前路由的模型档案没有声明图片输入能力 */
    modelUnsupported:
      '当前模型不支持图片输入（模型档案未声明 supports_image_input），read_image 已拒绝执行。请切换到支持视觉的模型，或先在模型设置里为该模型补充图片输入能力。',
    /** 追加进模型上下文的图像消息抬头（模型侧文案） */
    attached: '工具 {{tool}} 读取的图片：{{path}}'
  },

  write: {
    written: '已写入 {{path}}（{{bytes}} 字节）',
    failed: '写入文件失败: {{message}}'
  },

  edit: {
    /** 空 old_string 会让非重叠计数循环死循环，入口显式拒绝 */
    emptyOldString: 'old_string 不能为空：请提供文件中真实存在的原文片段作为查找目标。',
    noMatch:
      '未找到匹配内容，未做任何修改。请检查 old_string 是否与文件内容完全一致（包括空白与换行）。',
    /* 出现次数 / 替换处数走 mainPlural：中文两份相同，英文 1 occurrence / n occurrences */
    occurrences_one:
      'old_string 在文件中出现 {{count}} 次。请提供更长的唯一上下文，或将 replace_all 设为 true。',
    occurrences_other:
      'old_string 在文件中出现 {{count}} 次。请提供更长的唯一上下文，或将 replace_all 设为 true。',
    updated_one: '已更新 {{path}}：替换了 {{count}} 处。',
    updated_other: '已更新 {{path}}：替换了 {{count}} 处。',
    failed: '编辑文件失败: {{message}}'
  },

  applyPatch: {
    /** 补丁应用成功：{{summary}} 是逐文件摘要行 */
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

  /** str_replace_editor：view / create / str_replace / insert */
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

  ls: {
    failed: '列出目录失败: {{message}}'
  },

  glob: {
    failed: '搜索失败: {{message}}'
  },

  exec: {
    /** execute 输出硬上限截断 */
    truncated: '（输出过长，已截断）',
    /** 命令超时被终止 */
    timedOut: '（命令超时，已终止）',
    /** 该平台没有可用沙箱后端：命令**未执行**（故障关闭） */
    sandboxUnavailable: '沙箱不可用，命令未执行：{{reason}}',
    /** 沙箱后端自身启动失败：命令**未执行**（与「命令失败」区分开） */
    sandboxRunnerFailed: '沙箱后端启动失败，命令未执行：{{detail}}',
    /** 沙箱在操作系统层拒绝了这次操作（越界写入等） */
    sandboxDenied: '命令试图做沙箱允许范围之外的事（{{mode}} 模式），已被操作系统拒绝：',

    /* ── 后台运行（run_in_background） ── */
    /** 启动回执：告诉模型任务在后台继续、怎么读输出、怎么停 */
    backgroundStarted:
      '命令已在后台启动（job_id={{id}}）。你可以继续处理或总结本轮，不必等它结束；用 job_output(job_id="{{id}}") 增量读取输出，用 job_kill(job_id="{{id}}") 终止它。',
    /** 没有话题上下文（子代理路径）时拒绝后台运行 */
    backgroundNoTopic:
      '后台运行只在主代理的会话中可用（缺少话题上下文）。请改为前台执行，或让主代理启动这个任务。',
    /** 后台输出超过留存上限后补的一行 */
    backgroundTruncated: '（后台输出超过留存上限，后续输出已丢弃）',
    /** 命令退出时追加的终态行（模型/界面都能看到退出码） */
    backgroundExitCode: '（命令已退出，退出码 {{code}}）',
    /** 后台任务自身异常（启动/执行抛错，不是命令的非零退出） */
    backgroundFailed: '后台任务执行失败：{{message}}'
  },

  output: {
    /** formatOutput 的工具输出硬上限截断 */
    truncated: '（输出过大，已截断，共 {{total}} 字符）'
  },

  spill: {
    /** 超限结果内联预览中被略去的中间段 */
    middleOmitted: '……（中间 {{omitted}} 字符已省略）……',
    /** 溢出定位符 + 检索指引（read_file 带 offset/limit，或 grep 定位） */
    locator:
      '（输出共 {{total}} 字符，超出内联上限，完整结果已保存至 {{virtualPath}}。可用 read_file 加 offset/limit 按行读取该文件的片段，或用 grep 在 / 下检索关键字定位具体内容。）'
  },

  ask: {
    /**
     * 提问被本轮取消信号中止。`ASK_ABORTED` 是标识串，中英两份都必须原样保留
     * （调用方按 err.name === 'AskAbortedError' 判定，不按 message 匹配）。
     */
    aborted: '提问已取消（ASK_ABORTED）',
    /** 工具层返回给模型的取消说明 */
    abortedDetail: '提问已取消（ASK_ABORTED）：用户取消了本轮对话。',
    failed: '提问失败: {{message}}'
  },

  compaction: {
    /** 摘要模型只返回空白 */
    summaryEmpty: '摘要输出为空',
    /** 历史回灌时工具结果的裁剪标记（完整内容保留在会话记录里） */
    toolResultPruned: '……（{{omitted}} 字符已裁剪，完整内容保留在会话记录中）……',
    /** 旧工具结果被清理后的占位符：保留“调用过什么”，去掉原始字节（结构不能删） */
    observationMasked:
      '[旧工具结果已清理] {{call}}（callId={{callId}}）。如需原始内容，请重新读取该文件或重跑该命令。',
    /** 压缩后重注入的标题（文件内容跟在后面） */
    restoredContext: '以下是你压缩前读过/改过的文件（自动恢复，供继续工作参考）：',
    /** 压缩后重注入的待办清单标题 */
    restoredTodos: '当前待办清单：'
  },

  /**
   * 沙箱（权限档位）相关文案。
   *
   * `[sandbox: ...]` 标记本身是**协议字符串**，不在这里——真源在 runtime/permission.ts
   * （模型按标记识别拦截，工装按标记断言），这里只放跟随界面语言的正文。
   */
  sandbox: {
    reason: {
      /** 仅可查看模式下写文件 */
      readOnlyWrite: '当前权限是「仅可查看」：写文件需要你临时提权后才能执行。',
      /** 仅可查看模式下的危险命令 */
      readOnlyExec: '当前权限是「仅可查看」：这条命令会改动系统，已被拦截（{{evidence}}）。',
      /** 仅可查看模式下的外部工具（无法确认是否只读） */
      readOnlyExternal: '当前权限是「仅可查看」：无法确认这个外部工具（MCP / 插件）是否只读。',
      /** 命令里出现工作区以外的路径 */
      outsidePath: '命令里出现工作区以外的路径：{{evidence}}',
      /** 命令里出现危险操作 */
      riskyCommand: '命令里出现危险操作：{{evidence}}'
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
      riskyCommand: 'Command contains a risky operation: {{evidence}}'
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

/** 按当前界面语言取文件系统/溢出/提问/压缩的工具文案树 */
export function getFsToolTexts(): typeof zhCNFsToolTexts {
  return getMainLanguage() === 'en-US' ? enUSFsToolTexts : zhCNFsToolTexts
}
