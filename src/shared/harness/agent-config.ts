/**
 * 会话级「本轮启用选择」的共享口径（渲染层 / 主进程 / 定时任务共用）。
 *
 * 语义（用户 2026-11-27 口径：新增的 MCP 与技能不能默认开启，要在输入框下面选）：
 * - `tools === null`：不覆盖，跟主智能体默认工具；
 * - `skills === null`：**不启用任何技能**；
 * - `mcpTools === null`：**不启用任何 MCP 工具**。
 *
 * 三类值都是「字符串数组或 null」；非法输入一律收敛为 null（绝不把脏数据写进会话配置）。
 */

/** 会话级运行选择（null = 该维度不覆盖 / 不启用，见文件头注释） */
export interface AgentSelection {
  tools: string[] | null
  skills: string[] | null
  mcpTools: string[] | null
}

/** 清洗一个字符串数组（去空白、去重、过滤非字符串；空数组保留为 []） */
function cleanNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (!value || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/** 解析外部（IPC / 数据库 JSON）传来的选择；任何字段非法都收敛为 null */
export function normalizeAgentSelection(raw: unknown): AgentSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  return {
    tools: cleanNames(input.tools),
    skills: cleanNames(input.skills),
    mcpTools: cleanNames(input.mcpTools)
  }
}

/**
 * 合并两层选择：`override` 里**非 null** 的维度覆盖 `base`。
 *
 * 用于「任务上存的选择」叠加到「会话上存的选择」：任务里明确选过的维度优先，
 * 没选的维度继续跟随会话/默认。
 */
export function mergeAgentSelection(
  base: AgentSelection | null | undefined,
  override: AgentSelection | null | undefined
): AgentSelection {
  return {
    tools: override?.tools !== null && override?.tools !== undefined ? override.tools : (base?.tools ?? null),
    skills:
      override?.skills !== null && override?.skills !== undefined
        ? override.skills
        : (base?.skills ?? null),
    mcpTools:
      override?.mcpTools !== null && override?.mcpTools !== undefined
        ? override.mcpTools
        : (base?.mcpTools ?? null)
  }
}

/** 是否为一个「什么都没选」的选择（全 null） */
export function isEmptyAgentSelection(selection: AgentSelection | null | undefined): boolean {
  if (!selection) return true
  return selection.tools === null && selection.skills === null && selection.mcpTools === null
}
