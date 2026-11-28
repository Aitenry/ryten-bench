import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'

/**
 * Skill loader — replaces the skills middleware
 *
 * Directory convention (same as the harness-list-skills IPC): every subdirectory of skillsPath that
 * contains SKILL.md is a skill, and the head of SKILL.md is YAML frontmatter (name / description).
 *
 * Injection strategy: the system prompt only carries the **index** (name + description + one line
 * "load it with the skill tool"), and the body is returned by the `skill` tool on demand. An early
 * implementation put every skill body (up to 4k) straight into the prompt, which ate the 16k budget
 * once there were many skills and cost on every turn; with on-demand loading the prompt cost grows
 * linearly with the number of skills but stays small, and bodies enter the context only when they
 * are actually used.
 */

export interface SkillInfo {
  /** Skill directory name (stable ID) */
  id: string
  /** name from frontmatter, falling back to the directory name */
  name: string
  /** description from frontmatter */
  description: string
  /** SKILL.md body (frontmatter removed; truncated when too long) */
  content: string
}

export interface SkillLoaderOptions {
  skillsPath?: string
  /** Enabled skill ids; undefined means all are enabled */
  enabledSkills?: string[]
}

/** Body cap per skill (length returned to the model by the skill tool) */
const MAX_SKILL_CHARS = 32_000

/** Parse SKILL.md frontmatter (same logic as the harness-list-skills IPC) */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm) return {}
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return { name, description }
}

/** Scan and load the skill list */
export function loadSkills(options: SkillLoaderOptions): SkillInfo[] {
  if (!options.skillsPath) return []
  const skills: SkillInfo[] = []
  try {
    const entries = fs.readdirSync(options.skillsPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (options.enabledSkills && !options.enabledSkills.includes(entry.name)) continue
      const skillMdPath = path.join(options.skillsPath, entry.name, 'SKILL.md')
      try {
        fs.accessSync(skillMdPath, fs.constants.R_OK)
        const content = fs.readFileSync(skillMdPath, 'utf-8')
        const { name, description } = parseSkillFrontmatter(content)
        // Strip the frontmatter, keep the body
        const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim()
        skills.push({
          id: entry.name,
          name: name ?? entry.name,
          description: description ?? '',
          content:
            body.length > MAX_SKILL_CHARS
              ? body.slice(0, MAX_SKILL_CHARS) + '\n... (truncated)'
              : body
        })
      } catch {
        // SKILL.md is unreadable: skip
      }
    }
  } catch (err) {
    logger.warn('[Skills] Failed to scan skills directory:', err)
  }
  return skills
}

/**
 * Skill index section (system prompt): lists only names, ids and descriptions, and tells the model
 * to load bodies with the `skill` tool.
 *
 * Each entry has a fixed format so the model can pass precise arguments: `- <name> (<id>):
 * <description>`.
 */
export function buildSkillsPromptSection(skills: SkillInfo[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => {
    const description = skill.description ? `: ${skill.description}` : ''
    return `- ${skill.name} (${skill.id})${description}`
  })
  return [
    '',
    '## Available Skills',
    'Skills are reusable instruction sets. Each line below is `name (id): description`.',
    'When a request matches a skill, call the `skill` tool with that skill name (or its id) to load its full instructions before acting. Do not guess a skill body from its description.',
    ...lines
  ].join('\n')
}

/** Find a skill by name or id (name compare is case-insensitive; exact id match wins) */
export function findSkill(skills: SkillInfo[], nameOrId: string): SkillInfo | undefined {
  const needle = nameOrId.trim()
  if (!needle) return undefined
  const byId = skills.find((skill) => skill.id === needle)
  if (byId) return byId
  const lowered = needle.toLowerCase()
  return (
    skills.find((skill) => skill.name.toLowerCase() === lowered) ??
    skills.find((skill) => skill.id.toLowerCase() === lowered)
  )
}

