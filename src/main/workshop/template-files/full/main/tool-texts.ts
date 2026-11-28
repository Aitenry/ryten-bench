import { getMainLanguage } from '@host/main/i18n'

/**
 * Tool result texts for ${vars.title} (shown on the tool card, following the UI language).
 *
 * Why a separate copy: the strings the model sees enter the conversation verbatim, so **the user
 * sees them too** — the texts ship with the plugin and disappear when it is disabled (do not put
 * them in the host kernel's text table).
 */
export const zhCNToolTexts = {
  common: {
    unknownAction: '未知动作：{{action}}。支持：{{supported}}'
  },
  ${vars.sqlName}: {
    empty: '还没有任何记录。',
    listHeader: '**${vars.title}**（{{count}} 条）\n',
    listLine: '  [{{id}}] {{title}}{{done}}',
    doneMark: '（已完成）',
    added: '已添加「{{title}}」（id={{id}}）。',
    updated: '已更新 [{{id}}]。',
    removed: '已删除 [{{id}}]。',
    notFound: '没有 id={{id}} 的记录。'
  }
} as const

export const enUSToolTexts: typeof zhCNToolTexts = {
  common: {
    unknownAction: 'Unknown action: {{action}}. Supported: {{supported}}'
  },
  ${vars.sqlName}: {
    empty: 'No records yet.',
    listHeader: '**${vars.title}** ({{count}})\n',
    listLine: '  [{{id}}] {{title}}{{done}}',
    doneMark: ' (done)',
    added: 'Added "{{title}}" (id={{id}}).',
    updated: 'Updated [{{id}}].',
    removed: 'Removed [{{id}}].',
    notFound: 'No record with id={{id}}.'
  }
}

/** Texts for the current UI language */
export function getToolTexts(): typeof zhCNToolTexts {
  return getMainLanguage() === 'en-US' ? enUSToolTexts : zhCNToolTexts
}

/** Tool description (shown to the model; also displayed under Settings → Agent → Tools) */
export function toolDescriptions(): { zh: string; en: string } {
  return {
    zh: '读写「${vars.title}」：action=list 列全部；add 新增一条；done 标记完成；remove 删除一条。',
    en: 'Read and write "${vars.title}": action=list all; add a record; done marks it complete; remove deletes one.'
  }
}
