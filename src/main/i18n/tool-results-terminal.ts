import { getMainLanguage } from './index'

/**
 * 持久终端工具（terminal_*）文案。
 *
 * 中文是源语言，英文树用 `typeof` 约束键一致。命令输出属于用户数据、原样返回，不翻译。
 */
export const zhCNTerminalTexts = {
  /** 档位不足时的拒绝（A 方案：只有完全权限档可用） */
  denied:
    '当前权限档位是「{{mode}}」。持久终端会以你的身份执行任意命令、且不做隔离，因此只在「完全权限」档可用——请让用户切换到该档位后重试。',
  modeReadOnly: '只读',
  modeWorkspace: '工作区可写',
  modeDanger: '完全权限',
  noWorkspace: '当前会话没有工作区目录，无法打开终端。',
  openFailed: '打开终端失败：{{message}}',
  tooMany: '每个话题最多 {{limit}} 个终端会话。请先关闭不用的会话（terminal_list 可查看）。',
  invalidCwd: '工作目录不存在或不是目录：{{cwd}}',
  noShell: '没有可用的 shell（Windows 需要 pwsh 或 cmd）。',
  opened: '已打开终端 {{id}}（{{shell}}，工作目录 {{cwd}}）。会话在关闭前一直保持；用 terminal_send 执行命令。',
  notFound: '找不到终端会话 {{id}}（可能已关闭或空闲超时）。',
  busy: '该终端上一条命令还没结束。用 terminal_read 可以继续读取它的输出，稍后再试。',
  exited: '终端进程已结束（退出码 {{code}}）。请重新 terminal_open。',
  emptyCommand: '命令为空。',
  tooLongCommand: '命令过长（上限 {{max}} 字符）。',
  nulCommand: '命令包含非法字符（NUL）。',
  spawnFailed: 'shell 启动失败：{{message}}',
  /** terminal_send 结果 */
  sendHeader: '## 终端输出（{{id}}）',
  timedOut:
    '⏱ 等待 {{wait}}ms 仍未结束：命令可能还在运行。用 terminal_read 继续读取输出；不要重复发送同一条命令。',
  outputEmpty: '（本轮没有输出）',
  binaryNote: '（命令输出看起来是二进制内容，正文已省略，共 {{chars}} 字符）',
  unreadNote: '（还有 {{chars}} 字符未读，可用 terminal_read 读取）',
  /** terminal_read 结果 */
  readHeader: '## terminal_read（{{id}}）',
  readEmpty: '（没有未读输出）',
  readTruncated: '（本次读取有截断，剩余内容仍在缓冲中）',
  readDropped: '（另有 {{chars}} 字符因环形缓冲上限被丢弃）',
  /** terminal_close */
  closed: '已关闭终端 {{id}}。',
  closeNotFound: '终端会话 {{id}} 不存在（可能已经关闭）。',
  /** terminal_list */
  listHeader: '## 终端会话（{{count}}）',
  listEmpty: '当前话题没有终端会话。用 terminal_open 新建一个。',
  listItem: '- {{id}}：{{shell}}，{{cwd}}，{{state}}，未读 {{unread}} 字符',
  stateAlive: '运行中',
  stateDead: '已结束',
  none: '—'
}

export const enUSTerminalTexts: typeof zhCNTerminalTexts = {
  denied:
    'The current permission mode is "{{mode}}". A persistent terminal runs arbitrary commands as you and is not sandboxed, so it is only available in "danger-full-access" — ask the user to switch modes and retry.',
  modeReadOnly: 'read-only',
  modeWorkspace: 'workspace-write',
  modeDanger: 'danger-full-access',
  noWorkspace: 'This session has no workspace directory, so a terminal cannot be opened.',
  openFailed: 'Failed to open the terminal: {{message}}',
  tooMany:
    'At most {{limit}} terminal sessions per conversation. Close one first (terminal_list shows them).',
  invalidCwd: 'The working directory does not exist or is not a directory: {{cwd}}',
  noShell: 'No usable shell found (Windows needs pwsh or cmd).',
  opened:
    'Opened terminal {{id}} ({{shell}}, cwd {{cwd}}). It stays alive until closed; use terminal_send to run commands.',
  notFound: 'Terminal session {{id}} was not found (it may be closed or idle-timed-out).',
  busy: 'The previous command on this terminal is still running. Use terminal_read to fetch its output and retry later.',
  exited: 'The terminal process has exited (code {{code}}). Open a new terminal.',
  emptyCommand: 'The command is empty.',
  tooLongCommand: 'The command is too long (limit {{max}} characters).',
  nulCommand: 'The command contains an illegal NUL character.',
  spawnFailed: 'Failed to start the shell: {{message}}',
  sendHeader: '## Terminal output ({{id}})',
  timedOut:
    '⏱ Still running after {{wait}}ms: the command may be busy. Use terminal_read to keep reading; do not resend the same command.',
  outputEmpty: '(no output for this command)',
  binaryNote: '(the output looks binary, body omitted, {{chars}} characters)',
  unreadNote: '({{chars}} more characters are unread; use terminal_read)',
  readHeader: '## terminal_read ({{id}})',
  readEmpty: '(no unread output)',
  readTruncated: '(this read was truncated; the rest is still buffered)',
  readDropped: '({{chars}} characters were dropped by the ring buffer cap)',
  closed: 'Closed terminal {{id}}.',
  closeNotFound: 'Terminal session {{id}} does not exist (it may already be closed).',
  listHeader: '## Terminal sessions ({{count}})',
  listEmpty: 'No terminal sessions in this conversation. Create one with terminal_open.',
  listItem: '- {{id}}: {{shell}}, {{cwd}}, {{state}}, {{unread}} unread characters',
  stateAlive: 'running',
  stateDead: 'exited',
  none: '—'
}

/** 按当前界面语言取终端工具文案 */
export function getTerminalToolTexts(): typeof zhCNTerminalTexts {
  return getMainLanguage() === 'en-US' ? enUSTerminalTexts : zhCNTerminalTexts
}

export type TerminalToolTexts = typeof zhCNTerminalTexts
