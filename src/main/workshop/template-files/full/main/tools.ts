import { tool } from '@host/main/ai/tools'
import * as z from 'zod/v4'
import { mainFormat } from '@host/main/i18n'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
import { createItem, deleteItem, listItems, updateItem } from './db/mapper'
import { getToolTexts, toolDescriptions } from './tool-texts'

/**
 * ${vars.title} 给助手的 AI 工具。
 *
 * 两条规矩：
 * - 经 **工具贡献点**（HARNESS_TOOL_CONTRIBUTION）注册：插件停用时 harness 拉不到这条贡献，
 *   工具自然从模型面前消失（不需要去改宿主的工具表）；
 * - 工具读的是**本插件自己的 mapper**（与页面同一份数据），不跨插件直读别人的表。
 */
export const ITEM_TOOL_NAME = '${vars.itemsToolName}'

export function createToolContribution(): {
  name: string
  info: { name: string; label: string; description: string; icon: string; color: string }
  build: () => unknown
} {
  const desc = toolDescriptions()
  return {
    name: ITEM_TOOL_NAME,
    info: {
      name: ITEM_TOOL_NAME,
      label: ${vars.titleJson},
      description: desc.zh,
      icon: 'RiToolsLine',
      color: '#8b5cf6'
    },
    build: () =>
      tool(
        async (input: {
          action: 'list' | 'add' | 'done' | 'remove'
          title?: string
          id?: number
        }) => {
          const texts = getToolTexts()["${vars.sqlName}"]
          const supported = 'list, add, done, remove'
          if (!input || !supported.includes(String(input.action))) {
            return mainFormat(getToolTexts().common.unknownAction, {
              action: String(input?.action ?? ''),
              supported
            })
          }
          if (input.action === 'list') {
            const items = await listItems()
            if (items.length === 0) return texts.empty
            const lines = [mainFormat(texts.listHeader, { count: items.length })]
            for (const item of items) {
              lines.push(
                mainFormat(texts.listLine, {
                  id: item.id,
                  title: item.title,
                  done: item.done ? texts.doneMark : ''
                })
              )
            }
            return lines.join('\n')
          }
          if (input.action === 'add') {
            const title = String(input.title ?? '').trim()
            if (!title) return texts.empty
            const item = await createItem({ title })
            return mainFormat(texts.added, { title: item.title, id: item.id })
          }
          const id = Number(input.id)
          if (!Number.isFinite(id)) {
            return mainFormat(texts.notFound, { id: String(input.id ?? '') })
          }
          if (input.action === 'done') {
            const item = await updateItem(id, { done: true })
            return item ? mainFormat(texts.updated, { id }) : mainFormat(texts.notFound, { id })
          }
          const removed = await deleteItem(id)
          return removed ? mainFormat(texts.removed, { id }) : mainFormat(texts.notFound, { id })
        },
        {
          name: ITEM_TOOL_NAME,
          description: desc.zh,
          schema: z.object({
            action: z.enum(['list', 'add', 'done', 'remove']),
            title: z.string().optional().describe('add 时的标题'),
            id: z.number().optional().describe('done / remove 时的记录 id')
          })
        }
      )
  }
}

export { HARNESS_TOOL_CONTRIBUTION }
