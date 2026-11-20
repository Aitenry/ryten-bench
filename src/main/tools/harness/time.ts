import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { getMainLanguage } from '../../i18n'

// ============================================================================
// Time Tool — 时间查询
// ============================================================================

export function buildGetTimeTool(): StructuredToolInterface {
  return tool(
    () =>
      Promise.resolve(
        // 结果会渲染在工具卡片上，日期格式跟随界面语言
        new Date().toLocaleString(getMainLanguage() === 'en-US' ? 'en-US' : 'zh-CN', {
          timeZone: 'Asia/Shanghai'
        })
      ),
    {
      name: 'get_time',
      description: 'Get the current date and time.',
      schema: z.object({})
    }
  )
}
