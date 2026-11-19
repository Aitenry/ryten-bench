import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'

/**
 * 技能加载器 — 替代 deepagents skills 中间件
 *
 * 目录约定（与 harness-list-skills IPC 一致）：skillsPath 下每个含 SKILL.md 的子目录即一个技能，
 * SKILL.md 头部为 YAML frontmatter（name / description）。
 *
 * 加载策略：读取技能名/描述与正文，注入系统提示词（带大小上限），
 * 使模型无需文件系统访问即可感知技能能力。
 */

export interface SkillInfo {
  /** 技能目录名（稳定 ID） */
  id: string
  /** frontmatter 中的 name，回退为目录名 */
  name: string
  /** frontmatter 中的 description */
  description: string
  /** SKILL.md 正文（截断后） */
  content: string
}

export interface SkillLoaderOptions {
  skillsPath?: string
  /** 启用的技能 ID 列表；undefined 表示全部启用 */
  enabledSkills?: string[]
}

/** 单个技能正文注入上限 */
const MAX_SKILL_CHARS = 4_000
/** 技能段总注入上限 */
const MAX_TOTAL_CHARS = 16_000

/** 解析 SKILL.md frontmatter（与 harness-list-skills IPC 同一逻辑） */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm) return {}
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return { name, description }
}

/** 扫描并加载技能列表 */
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
        // 去掉 frontmatter，保留正文
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
        // SKILL.md 不可读，跳过
      }
    }
  } catch (err) {
    logger.warn('[Skills] 扫描技能目录失败:', err)
  }
  return skills
}

/** 构建技能段系统提示词 */
export function buildSkillsPromptSection(skills: SkillInfo[]): string {
  if (skills.length === 0) return ''
  let prompt = `\n\n## Available Skills\nSkills you can use. When a user request falls within one of these skills, follow that skill's instructions:\n`
  let total = 0
  for (const skill of skills) {
    const block = `\n### ${skill.name} (${skill.id})\n${skill.description ? `Description: ${skill.description}\n` : ''}${skill.content}`
    total += block.length
    if (total > MAX_TOTAL_CHARS) {
      prompt += `\n(too many skills; the remaining ones are omitted)`
      break
    }
    prompt += block
  }
  return prompt
}
