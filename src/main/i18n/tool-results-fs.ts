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
    sandboxDenied: '命令试图做沙箱允许范围之外的事（{{mode}} 模式），已被操作系统拒绝：'
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
    toolResultPruned: '……（{{omitted}} 字符已裁剪，完整内容保留在会话记录中）……'
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
      'The command tried to do something outside what the sandbox allows ({{mode}} mode) and the operating system denied it:'
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
      '……({{omitted}} characters pruned; the full content is kept in the conversation record)……'
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
