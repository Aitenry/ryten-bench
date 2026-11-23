import { getMainLanguage } from '@host/main/i18n'

/**
 * ${vars.title} 工具的返回文案（显示在工具卡片上，跟随界面语言）。
 *
 * 为什么单独一份：模型看到的字符串会原样进对话，**用户也会看到**——
 * 文案随插件走，插件停用就一起消失（别塞进宿主内核的文案表）。
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

/** 当前界面语言对应的文案 */
export function getToolTexts(): typeof zhCNToolTexts {
  return getMainLanguage() === 'en-US' ? enUSToolTexts : zhCNToolTexts
}

/** 工具描述（给模型看的；也显示在设置 → 智能体 → 工具里） */
export function toolDescriptions(): { zh: string; en: string } {
  return {
    zh: '读写「${vars.title}」：action=list 列全部；add 新增一条；done 标记完成；remove 删除一条。',
    en: 'Read and write "${vars.title}": action=list all; add a record; done marks it complete; remove deletes one.'
  }
}
