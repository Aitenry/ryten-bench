import type React from 'react'
import { RiCalendarTodoLine, RiTargetLine } from '@remixicon/react'

/**
 * 输入框命令面（slash menu）的命令目录与过滤规则。
 *
 * 与视图分开（`HarnessSlashMenu.tsx` 只导出组件）：Fast Refresh 要求组件文件只导出组件，
 * 纯数据/纯函数放在这里，输入框也能直接复用同一份目录做键盘导航。
 *
 * 当前只保留「目标 / 计划」两条（参考截图里其余命令行被用户划掉）。
 */

export type HarnessSlashCommandId = 'goal' | 'plan'

/** 命令文案键（中文源语言推导的类型；两边保持一致才能过 `t()` 的键校验） */
export type HarnessSlashCommandLabelKey =
  'harness.input.commands.goalLabel' | 'harness.input.commands.planLabel'

export type HarnessSlashCommandDescriptionKey =
  'harness.input.commands.goalDescription' | 'harness.input.commands.planDescription'

export interface HarnessSlashCommandDef {
  id: HarnessSlashCommandId
  /** 命令英文名（行内别名；DSH 菜单里的 `goal` / `plan`） */
  alias: string
  labelKey: HarnessSlashCommandLabelKey
  descriptionKey: HarnessSlashCommandDescriptionKey
  icon: React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>
}

export const HARNESS_SLASH_COMMANDS: HarnessSlashCommandDef[] = [
  {
    id: 'goal',
    alias: 'goal',
    labelKey: 'harness.input.commands.goalLabel',
    descriptionKey: 'harness.input.commands.goalDescription',
    icon: RiTargetLine
  },
  {
    id: 'plan',
    alias: 'plan',
    labelKey: 'harness.input.commands.planLabel',
    descriptionKey: 'harness.input.commands.planDescription',
    icon: RiCalendarTodoLine
  }
]

/**
 * 按查询词过滤命令（中文名 / 英文名 / 说明的子串匹配，忽略大小写与首尾空白）。
 *
 * @param translate i18n 的 `t`（只用到「返回字符串」这一面）
 * @param query `/` 后面的文本（空串 = 全部）
 */
export function filterSlashCommands(
  translate: (key: HarnessSlashCommandLabelKey | HarnessSlashCommandDescriptionKey) => string,
  query: string
): HarnessSlashCommandDef[] {
  const q = query.trim().toLowerCase()
  if (!q) return HARNESS_SLASH_COMMANDS
  return HARNESS_SLASH_COMMANDS.filter((command) => {
    const haystack = [command.alias, translate(command.labelKey), translate(command.descriptionKey)]
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
}
