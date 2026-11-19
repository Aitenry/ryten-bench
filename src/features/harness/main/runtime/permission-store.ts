import { settingsStore } from '../../../../main/context'
import { mainFormat } from '../../../../main/i18n'
import { getFsToolTexts } from '../../../../main/i18n/tool-results-fs'
import type { HarnessSettings } from '../../../../main/types/settings'
import { permissionGate, type GateTexts } from './permission-gate'
import {
  APPROVAL_REJECTED,
  APPROVAL_UNAVAILABLE,
  DEFAULT_PERMISSION_MODE,
  ESCALATION_HINT,
  ESCALATION_UNAVAILABLE,
  denyMarker,
  normalizeMode,
  type DenyReason,
  type EscalationError,
  type PermissionMode
} from './permission'

/**
 * 权限档位的**持久化与接线**（electron-store 的 `permissions` 键 + 闸门接线）。
 *
 * 为什么档位不进数据库：档位是「这次会话怎么跑」的会话级开关，不是对话内容；
 * 放 electron-store 的独立顶层键（与 `mainAgent` / `mcp` 同款做法）就不必为它做
 * drizzle 迁移，删话题时残留一条小记录也无害。形状：
 *
 * ```json
 * { "permissions": { "defaultMode": "workspace-write", "byTopic": { "12": "read-only" } } }
 * ```
 *
 * 两层（对齐 DSH）：
 * - `defaultMode`：**之后新建**的话题用哪个档位（设置页「智能体」里的默认权限模式）；
 * - `byTopic[topicId]`：当前话题的选择（输入框左下角的选择器），没有记录就用当时的默认值。
 *
 * 本文件同时是闸门的**接线点**：档位来源、工作区根目录、界面语言文案都在这里注入，
 * 于是 permission-gate.ts 自己不必认识 electron / i18n（离线回归因此跑得起来）。
 */

/** 持久化形状（脏数据一律在读取时归一，绝不抛错） */
export interface PermissionsConfig {
  defaultMode: PermissionMode
  /** 话题 id（字符串键，electron-store 的 JSON 对象键只能是字符串）→ 档位 */
  byTopic: Record<string, PermissionMode>
}

/** 读取（含归一）：任何脏值都回落到缺省档位 */
export function readPermissionsConfig(): PermissionsConfig {
  const raw = settingsStore.get('permissions') as Partial<PermissionsConfig> | undefined
  const byTopic: Record<string, PermissionMode> = {}
  const source = raw?.byTopic
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (/^\d+$/.test(key)) byTopic[key] = normalizeMode(value)
    }
  }
  return { defaultMode: normalizeMode(raw?.defaultMode), byTopic }
}

/** 写入（合并式：只覆盖传入的字段） */
function writePermissionsConfig(patch: Partial<PermissionsConfig>): PermissionsConfig {
  const next = { ...readPermissionsConfig(), ...patch }
  settingsStore.set('permissions', next)
  return next
}

/** 话题当前档位（没有话题记录 = 用默认值；新话题因此跟随「新会话默认」） */
export function permissionModeOf(topicId: number): PermissionMode {
  const config = readPermissionsConfig()
  if (topicId > 0) {
    const scoped = config.byTopic[String(topicId)]
    if (scoped) return scoped
  }
  return config.defaultMode
}

/** 前端要的完整状态（当前档位 + 新会话默认值） */
export function permissionStateFor(topicId?: number | null): {
  topicId: number
  mode: PermissionMode
  defaultMode: PermissionMode
} {
  const config = readPermissionsConfig()
  const id = typeof topicId === 'number' && topicId > 0 ? topicId : 0
  return {
    topicId: id,
    mode: id > 0 ? (config.byTopic[String(id)] ?? config.defaultMode) : config.defaultMode,
    defaultMode: config.defaultMode
  }
}

/** 切当前话题的档位（写入话题作用域，不动新会话默认值） */
export function setTopicPermissionMode(topicId: number, mode: PermissionMode): PermissionMode {
  if (!(topicId > 0)) return readPermissionsConfig().defaultMode
  const config = readPermissionsConfig()
  const next = { ...config.byTopic, [String(topicId)]: normalizeMode(mode) }
  writePermissionsConfig({ byTopic: next })
  return normalizeMode(mode)
}

/** 切「新会话默认」档位（设置页；不影响已有话题的选择） */
export function setDefaultPermissionMode(mode: PermissionMode): PermissionMode {
  const next = writePermissionsConfig({ defaultMode: normalizeMode(mode) })
  return next.defaultMode
}

/* ────────────────────────── 文案接线 ────────────────────────── */

/** 按原因码取本地化说明（模型看到的拦截文本与弹窗原因共用一份词条） */
function reasonText(code: DenyReason, evidence?: string): string {
  const tr = getFsToolTexts().sandbox
  switch (code) {
    case 'read-only-write':
      return tr.reason.readOnlyWrite
    case 'read-only-exec':
      return evidence ? mainFormat(tr.reason.readOnlyExec, { evidence }) : tr.reason.readOnlyExec
    case 'read-only-external':
      return tr.reason.readOnlyExternal
    case 'outside-path':
      return mainFormat(tr.reason.outsidePath, { evidence: evidence ?? '' })
    case 'risky-command':
    default:
      return evidence ? mainFormat(tr.reason.riskyCommand, { evidence }) : tr.reason.riskyCommand
  }
}

/** 升权参数不合法时的说明 */
function escalationText(error: EscalationError): string {
  const tr = getFsToolTexts().sandbox.escalation
  switch (error) {
    case 'invalid-mode':
      return tr.invalidMode
    case 'invalid-justification':
      return tr.invalidJustification
    case 'not-wider':
      return tr.notWider
    case 'not-previously-denied':
    default:
      return tr.notPreviouslyDenied
  }
}

/** 闸门文案（拒绝 / 原因 / 升权不可用）：标记是协议、正文跟随界面语言 */
const GATE_TEXTS: GateTexts = {
  denial: ({ mode, reason, evidence, detail }) =>
    `${denyMarker(mode)} ${reasonText(reason, evidence)}\n${ESCALATION_HINT}${detail ? `\n(${detail})` : ''}`,
  reason: (code, evidence) => reasonText(code, evidence),
  escalationUnavailable: (error) => `${ESCALATION_UNAVAILABLE} ${escalationText(error)}`
}

/** 用户拒绝 / 无人应答时展示给用户与模型的文本（ipc 层与卡片展示也会用到） */
export const PERMISSION_APPROVAL_REJECTED = APPROVAL_REJECTED
export const PERMISSION_APPROVAL_UNAVAILABLE = APPROVAL_UNAVAILABLE

/** 接线是否已完成（幂等；重复调用无副作用） */
let wired = false

/**
 * 接线闸门（插件 install 时调用一次）。
 *
 * 工作区根目录取「设置里的当前工作区」——`execute` 的 cwd 就是它，
 * 越界判定必须与真正执行命令时的工作目录是同一个值。
 */
export function wirePermissionGate(): void {
  if (wired) return
  wired = true
  permissionGate.setModeSource((topicId) => permissionModeOf(topicId))
  permissionGate.setWorkspaceRootSource(() => {
    const settings = settingsStore.get('harness') as HarnessSettings | undefined
    return settings?.workspacePath || undefined
  })
  permissionGate.setTexts(GATE_TEXTS)
}

/** 缺省档位常量再导出（设置页初始化用） */
export { DEFAULT_PERMISSION_MODE }
