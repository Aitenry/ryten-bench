/**
 * 沙箱权限策略的**纯逻辑**（零 import，可被 node 直接加载做离线回归）。
 *
 * 为什么单独一个文件：策略是「哪个档位下、哪次调用该放行 / 该问人 / 该拒绝」的判定真源，
 * 最容易被后续改动悄悄漂移（多一个工具、多一个动词就会改变拦截面）。判定必须能离线断言，
 * 而 permission-gate.ts（审批队列 + 工具包装）要触达 electron/electron-store，
 * 所以把规则搬到这里：谁都不 import，测试直接 `import` 本文件即可。
 *
 * 语义对齐 deepseek-harness（用户看到的就是那套「仅可查看 / 工作区内修改 / 完全权限」）：
 * - `read-only`        拒绝一切写入与破坏性命令；模型可用「升权重试」申请一次；
 * - `workspace-write`  工作区内的读写与常规命令直接跑；越界或危险操作先弹窗问人；
 * - `danger-full-access` 不再拦截（切换进来本身要过一次风险确认）。
 *
 * 与 DSH 的另一半（执行层强制）的关系（2026-09-27 补齐）：
 * DSH 用 OS 级沙箱（Linux Landlock/bwrap、macOS Seatbelt、Windows ACL 受限令牌）在内核层
 * 挡住子进程的越界写入。本项目现在也有**自研的跨平台沙箱服务**（`sandbox/`：
 * Windows 受限令牌 + 能力 SID + DACL、Linux Landlock 启动器 / bubblewrap、macOS sandbox-exec），
 * 真正的写入边界由它强制，且拿不到后端时**拒绝执行**（故障关闭）。
 * 因此本文件里的命令风险判定（正则）**只承担「审批提示层」**：把「看起来危险」的命令
 * 提前拿出来问人（破坏性删除、越界路径、发布/强推、下载即执行），不承担强制职责——
 * 它漏掉的构造由沙箱兜底，它误报的也只是多问一次。
 */

/* ────────────────────────── 档位 ────────────────────────── */

/** 权限档位（与 DSH 的三个内置预设同名同义） */
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 全部档位（设置页下拉与选择器按这个顺序渲染） */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access'
]

/** 缺省档位：工作区内修改（DSH 的内置默认预设也是它） */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'workspace-write'

/** 档位合法性收窄（配置/数据库里读到的值可能是脏的，一律回落到缺省） */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

/** 脏值归一：不是合法档位就用缺省（绝不抛错——设置读坏了不该让对话起不来） */
export function normalizeMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE
}

/**
 * 严格更宽的档位表（升权只能沿这张阶梯向上）。
 *
 * 封闭表的意义：`read-only` 可以升到 `workspace-write` 或 `danger-full-access`，
 * 而 `workspace-write` 只能升到 `danger-full-access`；「降权」与「原地重试」都不是升权，
 * 一律拒绝且**不打扰人**（不弹审批窗），否则模型可以靠反复请求把弹窗刷成噪音。
 */
export function widerModes(mode: PermissionMode): PermissionMode[] {
  const order: PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access']
  const index = order.indexOf(mode)
  return index < 0 ? [] : order.slice(index + 1)
}

/** 是否为「严格更宽」的升权目标 */
export function isStrictlyWider(next: PermissionMode, current: PermissionMode): boolean {
  return widerModes(current).includes(next)
}

/* ────────────────────────── 工具分类 ────────────────────────── */

/**
 * 工具在权限面上的类别：
 * - `read`     只读/无副作用（读文件、检索、计划清单、目标、后台任务、提问、记忆读写…）；
 * - `write`    写工作区文件（虚拟路径本身已被挂载表约束在工作区内）；
 * - `exec`     执行 shell 命令（唯一能碰到工作区之外的能力）；
 * - `external` 语义未知的外部工具（MCP 服务器 / 插件贡献的工具）——无法判定它是否只读。
 */
export type ToolAccess = 'read' | 'write' | 'exec' | 'external'

/** 写类工具（工作区内写入由挂载表兜底，权限面只管「这个档位允不允许写」） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

/** 执行类工具 */
const EXEC_TOOLS = new Set(['execute'])

/**
 * 只读 / 无副作用工具白名单。
 *
 * 刻意**枚举**而不是按名字前缀猜（`read_*`/`get_*`）：`mnemon_remember`、`write_todos`
 * 这类名字里有写动词、但写的是应用自己的数据（记忆 / 计划清单），不属于「用户的文件」，
 * 因此归只读面；反过来，任何没被枚举到的名字一律落进 `external`（未知 = 保守）。
 */
const READ_TOOLS = new Set([
  // 文件读取与检索
  'read_file',
  'ls',
  'glob',
  'grep',
  // 本地工具
  'get_time',
  'get_weather',
  // 交互与编排
  'ask_user_question',
  'write_todos',
  'read_todos',
  'create_goal',
  'get_goal',
  'update_goal',
  'job_list',
  'job_output',
  'job_kill',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'task',
  'workflow',
  // 记忆（写的是应用自己的记忆目录，不是用户工作区）
  'mnemon_memory_bodies',
  'mnemon_recall',
  'mnemon_related',
  'mnemon_status',
  'mnemon_document_search',
  'mnemon_runtime_memory',
  'mnemon_document_manage',
  'mnemon_document_create',
  'mnemon_remember',
  'mnemon_link',
  'mnemon_forget',
  'mnemon_memory_body_create',
  'mnemon_memory_body_update',
  'mnemon_memory_body_merge'
])

/** 按名字判定工具类别；未知名字落 `external`（MCP/插件工具走这条） */
export function classifyTool(name: string): ToolAccess {
  if (WRITE_TOOLS.has(name)) return 'write'
  if (EXEC_TOOLS.has(name)) return 'exec'
  if (READ_TOOLS.has(name)) return 'read'
  return 'external'
}

/* ────────────────────────── 命令静态风险判定 ────────────────────────── */

/**
 * 危险类别（**结构化原因码**，文案由调用方按界面语言渲染——本模块不产出任何自然语言）。
 */
export type CommandRiskCode =
  /** 提权（sudo / runas / Start-Process -Verb RunAs） */
  | 'privilege'
  /** 系统级配置：注册表、服务、用户账户、计划任务、磁盘、引导配置 */
  | 'system-config'
  /** 进程与电源控制：结束进程、关机重启 */
  | 'process-control'
  /** 把数据推出去：发布包、强推远端 */
  | 'exfiltrate'
  /** 下载即执行：管道给解释器、Invoke-Expression、编码命令 */
  | 'download-exec'
  /** 内联代码里出现破坏性 API（python -c / node -e 等，静态看不全，保守拦） */
  | 'inline-code'
  /** 命令里出现工作区以外的路径（绝对路径、UNC、家目录、环境变量展开） */
  | 'outside-path'
  /** 在工作区内做不可逆的递归删除 / 硬重置 */
  | 'destructive-workspace'

/** 命令风险判定结果 */
export interface CommandRisk {
  risky: boolean
  code?: CommandRiskCode
  /** 触发判定的原文片段（给用户看「是什么触发的」，也给工装断言用） */
  evidence?: string
}

/** 无风险的单例（避免每次新建对象） */
const SAFE: CommandRisk = { risky: false }

/** 取第一个命中的片段（供 evidence 展示） */
function firstMatch(text: string, re: RegExp): string | undefined {
  const m = re.exec(text)
  return m ? m[0] : undefined
}

/** 命中即危险的模式表（无需看路径的「无条件危险」构造） */
const UNCONDITIONAL_RISKS: { code: CommandRiskCode; re: RegExp }[] = [
  // 提权：普通用户态的命令不该需要管理员权限
  { code: 'privilege', re: /\b(sudo|runas)\b|Start-Process\b[^\n]*-Verb\s+RunAs/i },
  // 系统级配置
  {
    code: 'system-config',
    re: /\b(reg(\.exe)?\s+(add|delete|import|load|save|restore|copy)|sc(\.exe)?\s+(config|create|delete|start|stop|failure)|net(\.exe)?\s+(user|localgroup|share|accounts)|netsh|bcdedit|vssadmin|diskpart|schtasks|Set-ExecutionPolicy|Enable-PSRemoting|Disable-PSRemoting|New-LocalUser|Add-LocalGroupMember|takeown|icacls|cacls|attrib|setx|wmic\b[^\n]*\b(delete|call|set)\b|Set-ItemProperty\b[^\n]*(HKLM|HKCU|HKCR|Registry::)|New-ItemProperty\b[^\n]*(HKLM|HKCU|HKCR|Registry::))\b/i
  },
  // 进程与电源
  {
    code: 'process-control',
    re: /\b(taskkill|Stop-Process|Stop-Service|Stop-Computer|Restart-Computer|shutdown|pkill|killall)\b|\bkill\s+-9\b/i
  },
  // 把数据推出去（不可撤回）
  {
    code: 'exfiltrate',
    re: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bgit\s+push\b[^\n]*(--force|-f\b)|\bgit\s+push\b|\bgh\s+release\b|\btwine\s+upload\b/i
  },
  // 下载即执行 / 管道给解释器 / 编码命令
  {
    code: 'download-exec',
    re: /\|\s*(iex|Invoke-Expression|powershell|pwsh|cmd|bash|sh|node|python3?)\b|\b(iex|Invoke-Expression)\b|-EncodedCommand\b|\|\s*Out-String\b[^\n]*\|\s*iex/i
  },
  // 内联代码里的破坏性 API（静态看不全，保守拦）
  {
    code: 'inline-code',
    re: /(-c\s*["']|-e\s*["']|-Command\s*["'])[^\n]*\b(rmtree|unlink|os\.remove|shutil|subprocess|popen|os\.system|exec\(|eval\(|open\([^\n]*["'][wa]|Remove-Item|Stop-Process|Start-Process|Invoke-WebRequest|Invoke-RestMethod|requests\.(get|post)|urllib|socket|child_process|fs\.(rm|unlink|writeFile))\b/i
  }
]

/** 环境变量展开：一律视为工作区之外（%TEMP% 之类也不例外——宁可多问一次） */
const ENV_PATH_RE =
  /(%(USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SystemRoot|SystemDrive|ProgramFiles|ProgramData|HOMEPATH|HOMEDRIVE)%)|(\$env:[A-Za-z_]+)|(\$\{?(HOME|USERPROFILE|APPDATA)\}?)/i

/** 删除类动词（配合递归/通配/根目录目标时升级为危险） */
const DELETE_VERB_RE =
  /\b(del|erase|rmdir|rd|rm|remove-item|ri|shutil\.rmtree|rmtree|unlink|clear-content)\b/i

/** 递归 / 强制 / 通配标志（与删除动词同现才算「不可逆的大范围删除」） */
const RECURSIVE_FLAG_RE =
  /(\s-[a-z]*r[a-z]*\b|\s\/s\b|--recursive|-Recurse|-Force|\s-[a-z]*f[a-z]*\b|\*)/i

/** git 里会丢掉未提交工作的操作 */
const DESTRUCTIVE_GIT_RE = /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fd]|checkout\s+(--\s+)?\.)\b/i

/**
 * 路径令牌判定：这个令牌是不是「工作区之外」的路径？
 *
 * 保守原则：**能确定在工作区内才返回 false**（相对路径按 cwd = 工作区处理）。
 * 单字母 `/s`、`-rf` 这类开关不算路径令牌。
 */
function isOutsidePathToken(token: string, workspaceRoot?: string): boolean {
  // 去掉包裹的引号与尾随标点
  const raw = token.replace(/^["'`]+|["'`,;)]+$/g, '')
  if (!raw) return false
  // 开关：/s /q -rf --flag /p:Name
  if (/^-/.test(raw)) return false
  if (/^\/[A-Za-z](:|\b)/.test(raw) && raw.split('/').length === 2) return false

  // 环境变量展开
  if (ENV_PATH_RE.test(raw)) return true
  // 家目录
  if (raw === '~' || /^~[\\/]/.test(raw)) return true
  // UNC（\\server\share）与 //server/share
  if (/^(\\\\|\/\/)[^\\/]/.test(raw)) return true

  const driveQualified = /^[A-Za-z]:[\\/]/.test(raw)
  if (driveQualified) {
    if (!workspaceRoot) return true
    const norm = (p: string): string =>
      p
        .replace(/[\\/]+/g, '\\')
        .replace(/\\+$/, '')
        .toLowerCase()
    return !norm(raw).startsWith(norm(workspaceRoot))
  }
  // 无盘符的根相对路径（\Windows\... / /etc/passwd）
  if (/^\\/.test(raw)) return true
  if (/^\/(etc|usr|var|home|root|opt|tmp|bin|sbin|dev|proc|sys|mnt|media|windows)\b/i.test(raw)) {
    return true
  }
  // 其余相对路径按「在工作区内」处理（cwd = 工作区）
  return false
}

/** 拆分命令为令牌（只按空白与非路径分隔符切，够用且不会把 `C:\Program Files` 切碎加引号场景除外） */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens
}

/**
 * 判定一条 shell 命令的风险。
 *
 * @param command       模型给出的命令原文
 * @param workspaceRoot 工作区根目录（execute 的 cwd）；缺省时任何绝对路径都算越界
 * @returns 风险结果（含原因码与触发片段）
 */
export function inspectCommand(command: string, workspaceRoot?: string): CommandRisk {
  const text = String(command ?? '')
  if (!text.trim()) return SAFE

  // 1) 无条件危险构造
  for (const rule of UNCONDITIONAL_RISKS) {
    const evidence = firstMatch(text, rule.re)
    if (evidence) return { risky: true, code: rule.code, evidence: evidence.trim() }
  }

  // 2) 工作区以外的路径
  for (const token of tokenize(text)) {
    if (isOutsidePathToken(token, workspaceRoot)) {
      return { risky: true, code: 'outside-path', evidence: token.slice(0, 120) }
    }
  }

  // 3) git 里会丢工作的操作
  const git = firstMatch(text, DESTRUCTIVE_GIT_RE)
  if (git) return { risky: true, code: 'destructive-workspace', evidence: git.trim() }

  // 4) 删除类动词 + 递归/通配 → 工作区内的不可逆大范围删除
  const del = firstMatch(text, DELETE_VERB_RE)
  if (del && RECURSIVE_FLAG_RE.test(text)) {
    return { risky: true, code: 'destructive-workspace', evidence: del.trim() }
  }

  return SAFE
}

/* ────────────────────────── 调用判定 ────────────────────────── */

/** 拒绝 / 需要审批的原因码（文案由调用方本地化） */
export type DenyReason =
  'read-only-write' | 'read-only-exec' | 'read-only-external' | 'outside-path' | 'risky-command'

/** 判定动作 */
export type PermissionAction = 'allow' | 'approve' | 'deny'

export interface Verdict {
  action: PermissionAction
  reason?: DenyReason
  /** 触发判定的片段（命令风险判定给出） */
  evidence?: string
  /** 本次调用实际生效的档位（升权后是更宽的那个） */
  effectiveMode: PermissionMode
  /** 工具类别（弹窗与卡片展示用） */
  access: ToolAccess
}

export interface CallContext {
  mode: PermissionMode
  toolName: string
  args: Record<string, unknown>
  /** 工作区根目录（execute 的 cwd；越界判定要用） */
  workspaceRoot?: string
}

/**
 * 判定一次工具调用。
 *
 * 决策表（与 DSH 的沙箱模式 × 审批策略组合一致）：
 *
 * | 档位 \ 类别 | read | write | exec（安全命令） | exec（危险命令） | external |
 * |---|---|---|---|---|---|
 * | read-only        | 放行 | 拒绝+升权提示 | 放行 | 拒绝+升权提示 | 弹窗 |
 * | workspace-write  | 放行 | 放行 | 放行 | **弹窗** | 放行 |
 * | danger-full-access | 放行 | 放行 | 放行 | 放行 | 放行 |
 *
 * read-only 之所以是「拒绝 + 升权提示」而不是直接弹窗：档位是用户明确选的「别碰」，
 * 每次越界都弹窗会变成噪音；模型可以按提示用同一次调用申请升权，那时才弹窗（DSH 同款）。
 */
export function evaluateCall(input: CallContext): Verdict {
  const { mode, toolName, args, workspaceRoot } = input
  const access = classifyTool(toolName)

  if (mode === 'danger-full-access') {
    return { action: 'allow', effectiveMode: mode, access }
  }

  if (access === 'read') {
    return { action: 'allow', effectiveMode: mode, access }
  }

  if (access === 'write') {
    if (mode === 'read-only') {
      return { action: 'deny', reason: 'read-only-write', effectiveMode: mode, access }
    }
    return { action: 'allow', effectiveMode: mode, access }
  }

  if (access === 'exec') {
    const command = typeof args.command === 'string' ? args.command : ''
    const risk = inspectCommand(command, workspaceRoot)
    if (risk.risky) {
      if (mode === 'read-only') {
        return {
          action: 'deny',
          reason: 'read-only-exec',
          evidence: risk.evidence,
          effectiveMode: mode,
          access
        }
      }
      return {
        action: 'approve',
        reason: risk.code === 'outside-path' ? 'outside-path' : 'risky-command',
        evidence: risk.evidence,
        effectiveMode: mode,
        access
      }
    }
    return { action: 'allow', effectiveMode: mode, access }
  }

  // external：语义未知的外部工具
  if (mode === 'read-only') {
    return { action: 'approve', reason: 'read-only-external', effectiveMode: mode, access }
  }
  return { action: 'allow', effectiveMode: mode, access }
}

/* ────────────────────────── 升权重试 ────────────────────────── */

/** 升权参数（工具 schema 里的两个可选字段；只有被拒绝过的那一次调用才能用） */
export interface EscalationRequest {
  mode: PermissionMode
  justification: string
}

/** 升权参数校验失败的原因 */
export type EscalationError =
  'invalid-mode' | 'invalid-justification' | 'not-wider' | 'not-previously-denied'

export const MAX_JUSTIFICATION_CHARS = 1000

/**
 * 解析并校验升权参数（**不触达任何人**）。
 *
 * 校验顺序刻意如此：参数形态 → 是否严格更宽 → 这次调用是否真的刚被拒绝过。
 * 前两步失败属于「模型乱用参数」，直接返回拒绝文本即可；第三步把升权绑死在
 * 「同一次被拒绝的调用」上（DSH：retry this exact call once），
 * 模型不能凭空给自己开权限。
 */
export function parseEscalation(
  args: Record<string, unknown>,
  current: PermissionMode,
  previouslyDenied: boolean
): { ok: true; request: EscalationRequest } | { ok: false; error: EscalationError } {
  const rawMode = args.sandbox_permissions
  const rawJust = args.justification
  if (rawMode === undefined && rawJust === undefined) {
    // 没有升权参数：不该走这里（调用方只在带了参数时才问）
    return { ok: false, error: 'invalid-mode' }
  }
  if (!isPermissionMode(rawMode)) return { ok: false, error: 'invalid-mode' }
  if (typeof rawJust !== 'string' || !rawJust.trim()) {
    return { ok: false, error: 'invalid-justification' }
  }
  if (rawJust.length > MAX_JUSTIFICATION_CHARS) {
    return { ok: false, error: 'invalid-justification' }
  }
  if (!isStrictlyWider(rawMode, current)) return { ok: false, error: 'not-wider' }
  if (!previouslyDenied) return { ok: false, error: 'not-previously-denied' }
  return { ok: true, request: { mode: rawMode, justification: rawJust.trim() } }
}

/* ────────────────────────── 协议字符串 ────────────────────────── */

/**
 * 拒绝标记（**协议字符串**，模型与工装都按它识别拦截，不跟随界面语言）。
 * 对齐 DSH 的 `[sandbox: ... denied under <mode> mode]`。
 */
export function denyMarker(mode: PermissionMode): string {
  return `[sandbox: operation denied under ${mode} mode]`
}

/** 升权提示（同样是与 DSH 同形的协议字符串） */
export const ESCALATION_HINT =
  '[sandbox: escalation available — retry this exact call once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'

/** 升权不可用（参数非法 / 不该升权的调用）*/
export const ESCALATION_UNAVAILABLE = '[sandbox: escalation is not available for this call]'

/** 用户拒绝了这次调用 */
export const APPROVAL_REJECTED = '[sandbox: the user rejected this call]'

/** 没有可用应答者（渲染进程不在 / 审批通道未接线）：按「拒绝」关闭，绝不静默放行 */
export const APPROVAL_UNAVAILABLE = '[sandbox: approval unavailable — the request fails closed]'

/* ────────────────────────── 展示辅助 ────────────────────────── */

/** 取本次调用的「签名」（工具名 + 除升权参数外的参数），用于把升权绑死在被拒绝的调用上 */
export function callSignature(toolName: string, args: Record<string, unknown>): string {
  const plain: Record<string, unknown> = {}
  for (const key of Object.keys(args ?? {}).sort()) {
    if (key === 'sandbox_permissions' || key === 'justification') continue
    plain[key] = (args as Record<string, unknown>)[key]
  }
  let text = ''
  try {
    text = JSON.stringify(plain)
  } catch {
    text = String(plain)
  }
  return `${toolName}:${text}`
}

/**
 * 人类可读的「这次要做什么」（弹窗正文与卡片消息都用它）。
 *
 * 只按参数的**形状**挑最有信息量的那一项（命令全文 / 文件路径 / 检索式 / 目录），
 * 工具名不参与——工具名在弹窗与卡片上另有位置。
 */
export function describeCall(_toolName: string, args: Record<string, unknown>): string {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.command === 'string') return a.command
  if (typeof a.file_path === 'string') {
    const extra =
      typeof a.old_string === 'string'
        ? ' (edit)'
        : typeof a.content === 'string'
          ? ` (${String(a.content).length} chars)`
          : ''
    return `${String(a.file_path)}${extra}`
  }
  if (typeof a.pattern === 'string') return String(a.pattern)
  if (typeof a.path === 'string') return String(a.path)
  try {
    const text = JSON.stringify(a)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return '(unserializable arguments)'
  }
}

/* ────────────────────────── 系统提示词段 ────────────────────────── */

/**
 * 当前档位注入系统提示词的说明段（英文——与仓库里其它提示词同语言）。
 *
 * 说清三件事：当前档位、被拦下来时看到什么、**怎么申请一次升权**。
 * 最后一条是关键：不给模型这条路径，被拒绝的调用就只会变成一次失败重试。
 */
export function sandboxPromptSection(mode: PermissionMode): string {
  if (mode === 'danger-full-access') {
    return `\n\n## Sandbox
Sandbox mode: danger-full-access (the user turned interception off for this session). File writes and shell commands run without approval prompts. There is no sandbox to catch a mistake: keep destructive or irreversible actions rare, and prefer asking the user before anything that cannot be undone.`
  }
  if (mode === 'read-only') {
    return `\n\n## Sandbox
Sandbox mode: read-only (set by the user). The operating system itself enforces this: reading files and running harmless commands work normally, but every write (in the workspace included), every destructive command, and every external tool call is refused.
When a call is refused you get a result marked ${denyMarker('read-only')} together with an escalation hint. To ask the user for a one-off exception, retry that **exact same call once**, adding two arguments: sandbox_permissions (the narrowest wider mode that suffices, e.g. "workspace-write") and a one-line justification. The user sees a single approval prompt; if they allow it, that one call runs under the wider mode. A refusal without the hint is final — do not invent workarounds.`
  }
  return `\n\n## Sandbox
Sandbox mode: workspace-write (set by the user). The workspace directory is the only place you may write: the operating system denies every write outside it (and outside the private temp directory you are given), so a command that tries to modify files elsewhere fails with a sandbox denial instead of succeeding quietly.
- A denial comes back as ${denyMarker('workspace-write')} plus an escalation hint: you may retry that **exact same call once** with sandbox_permissions (the narrowest wider mode that suffices) and a one-line justification, and the user is asked to approve it once.
- Separately, a command that looks destructive (recursive deletes, hard resets, registry or service changes, killing processes, publishing or force-pushing, download-and-execute) is shown to the user for approval *before* it runs. If the user rejects it, stop that line of work and say what you would need instead — do not retry and do not look for a way around it.`
}
