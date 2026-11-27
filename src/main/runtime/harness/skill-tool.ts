import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import { findSkill, type SkillInfo } from './skills-core'

/**
 * `skill` 工具：按需加载技能全文（对应 DSH 的 dsh-tool-skill）。
 *
 * 与 `skills-core.ts` 分开的原因：核心（扫描/解析/索引）不依赖 ai/tools 与 i18n，
 * 可以离线单测；这里只负责工具 schema 与本地化文案。系统提示词只放技能索引
 * （见 buildSkillsPromptSection），正文由本工具在真正使用时返回。
 */
export function buildSkillTool(skills: SkillInfo[]): StructuredToolInterface {
  const texts = getAgentToolTexts()
  return tool(
    async ({ name }) => {
      const skill = findSkill(skills, name)
      if (!skill) {
        return mainFormat(texts.skill.notFound, {
          name,
          names: skills.map((item) => `${item.name} (${item.id})`).join(', ')
        })
      }
      return `${mainFormat(texts.skill.header, { name: skill.name, id: skill.id })}\n\n${skill.content}`
    },
    {
      name: 'skill',
      description:
        'Load the full instructions of a skill listed under "Available Skills" in the system prompt. Call it with the skill name (or id) before following that skill; the returned text is the skill body.',
      schema: z.object({
        name: z.string().describe('Skill name or directory id, exactly as listed in Available Skills')
      })
    }
  )
}
