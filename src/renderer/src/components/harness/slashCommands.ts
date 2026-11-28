import type React from 'react'
import { RiCalendarTodoLine, RiTargetLine } from '@remixicon/react'

/**
 * Command catalog and filtering rules for the input slash menu.
 *
 * Kept separate from the view (`HarnessSlashMenu.tsx` only exports the component): Fast Refresh
 * requires component files to export only components, so pure data/pure functions live here, and
 * the input can reuse the same catalog for keyboard navigation.
 *
 * Only the "goal / plan" entries are kept for now; the other command lines were dropped.
 */

export type HarnessSlashCommandId = 'goal' | 'plan'

/** Command label keys (types derived from the Chinese source locale; both sides must match to pass `t()` key validation) */
export type HarnessSlashCommandLabelKey =
  'harness.input.commands.goalLabel' | 'harness.input.commands.planLabel'

export type HarnessSlashCommandDescriptionKey =
  'harness.input.commands.goalDescription' | 'harness.input.commands.planDescription'

export interface HarnessSlashCommandDef {
  id: HarnessSlashCommandId
  /** Command alias used inline (`goal` / `plan` in the slash menu) */
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
 * Filter commands by query (substring match on alias / label / description, ignoring case and
 * surrounding whitespace).
 *
 * @param translate the i18n `t` (only its string-returning facet is used)
 * @param query text after `/` (empty string = all commands)
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
