import { tool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'
import * as z from 'zod/v4'
import { getMainLanguage } from '../../i18n'

// ============================================================================
// Time Tool — current date and time
// ============================================================================

export function buildGetTimeTool(): StructuredToolInterface {
  return tool(
    () =>
      Promise.resolve(
        // The result renders on the tool card; the date format follows the UI language
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
