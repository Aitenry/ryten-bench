/**
 * 子代理（智能体）配置的共享契约。
 *
 * 为什么放在 `shared/`：
 * - 设置页（渲染层）与主进程的 IPC 写入、以及「主智能体委派构建子代理」的工具
 *   （`agent_create`）都必须用**同一套**命名/长度/工具名规则，否则会出现
 *   「界面能存、模型工具拒收」或反过来；
 * - 这里只放纯函数与常量，不碰数据库/electron，渲染层与主进程都能直接 import，
 *   也方便 `tests/subagent-draft.test.mts` 这类 node 回归直接覆盖。
 *
 * 数据落库形态见 `src/main/database/schema/harness/agent.ts`；运行时形态
 * `SubAgentConfig` 见 `src/main/services/harness/types.ts`。
 */

/** 子代理标识（`task.subagent_type` 的取值）：与设置页表单规则一致 */
export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** 标识长度上限（数据库是 text，但工具 schema/提示词里太长没有意义） */
export const SUBAGENT_NAME_MAX_LENGTH = 32
/** 功能描述上限：会拼进 `task` 工具说明，过长会挤占主提示词 */
export const SUBAGENT_DESCRIPTION_MAX_LENGTH = 200
/** 系统提示词上限：子代理图每次请求都会带，太长会拖慢每一轮 */
export const SUBAGENT_PROMPT_MAX_LENGTH = 8000
/** 工具选择数量上限：子代理工具集按名字从注册表构建，过多没有意义 */
export const SUBAGENT_TOOLS_MAX_LENGTH = 64

/** `provider:model` 覆盖模型（可选）；与运行时 `resolveSubAgentModel` 的解析口径一致 */
export const SUBAGENT_MODEL_PATTERN = /^[^:\s]+:\S+$/

/** 草稿（设置页表单 / `agent_create` 工具参数归一后的共同形态） */
export interface SubAgentDraft {
  /** 唯一标识（同工作区内唯一），也是 `task.subagent_type` */
  name: string
  /** 界面显示名（可选；设置页叫「中文名」） */
  displayName?: string
  /** 功能描述：用于 `task` 工具里的能力清单 */
  description: string
  /** 系统提示词 */
  systemPrompt: string
  /** 可用工具名（可选；缺省由调用方决定继承范围） */
  tools?: string[]
  /** 可选覆盖模型 `provider:model` */
  model?: string
  /** 启用的技能 id（可选） */
  skills?: string[]
}

/**
 * 校验草稿的**纯格式规则**（不查数据库、不查工具注册表）。
 *
 * 返回人类可读的错误列表（空数组 = 通过）。设置页可以直接把第一条挂在表单上；
 * 主进程的 `agent_create` 工具把这些错误原样回给模型，让它自己纠正参数。
 */
export function validateSubAgentDraft(draft: SubAgentDraft): string[] {
  const errors: string[] = []

  const name = draft.name?.trim() ?? ''
  if (!name) {
    errors.push('name is required')
  } else if (name.length > SUBAGENT_NAME_MAX_LENGTH) {
    errors.push(`name must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters`)
  } else if (!SUBAGENT_NAME_PATTERN.test(name)) {
    errors.push('name must match ^[a-z][a-z0-9-]*$ (lowercase letters, digits, hyphen)')
  }

  const description = draft.description?.trim() ?? ''
  if (!description) {
    errors.push('description is required')
  } else if (description.length > SUBAGENT_DESCRIPTION_MAX_LENGTH) {
    errors.push(`description must be at most ${SUBAGENT_DESCRIPTION_MAX_LENGTH} characters`)
  }

  const systemPrompt = draft.systemPrompt?.trim() ?? ''
  if (!systemPrompt) {
    errors.push('systemPrompt is required')
  } else if (systemPrompt.length > SUBAGENT_PROMPT_MAX_LENGTH) {
    errors.push(`systemPrompt must be at most ${SUBAGENT_PROMPT_MAX_LENGTH} characters`)
  }

  if (draft.model != null && draft.model.trim() !== '') {
    if (!SUBAGENT_MODEL_PATTERN.test(draft.model.trim())) {
      errors.push('model must be in "provider:model" form')
    }
  }

  if (draft.tools != null) {
    if (draft.tools.length > SUBAGENT_TOOLS_MAX_LENGTH) {
      errors.push(`tools must contain at most ${SUBAGENT_TOOLS_MAX_LENGTH} entries`)
    }
    if (draft.tools.some((tool) => !tool.trim())) {
      errors.push('tools must not contain empty names')
    }
  }

  if (draft.skills != null && draft.skills.some((skill) => !skill.trim())) {
    errors.push('skills must not contain empty ids')
  }

  return errors
}
