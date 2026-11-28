import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import { findSkill, type SkillInfo } from './skills-core'

/**
 * `skill` tool: loads a skill's full text on demand.
 *
 * Why separate from `skills-core.ts`: the core (scan/parse/index) does not depend on ai/tools or
 * i18n and can be unit tested offline; this module only owns the tool schema and localized texts.
 * The system prompt only carries the skill index (see buildSkillsPromptSection); the body is
 * returned by this tool when it is actually used.
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
