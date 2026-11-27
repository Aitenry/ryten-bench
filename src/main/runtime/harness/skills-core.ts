import * as fs from 'fs'
import * as path from 'path'
import logger from 'electron-log'

/**
 * 技能加载器 — 替代 deepagents skills 中间件
 *
 * 目录约定（与 harness-list-skills IPC 一致）：skillsPath 下每个含 SKILL.md 的子目录即一个技能，
 * SKILL.md 头部为 YAML frontmatter（name / description）。
 *
 * 注入策略（对照 DSH 的 skill seam）：系统提示词只放**索引**（名字 + 描述 + 一句"用 skill
 * 工具加载"），正文由 `skill` 工具按需返回。早期实现把每个技能的正文（最多 4k）直接塞进
 * 提示词，技能一多就吃掉 16k 预算且每轮都付费；按需加载后，提示词成本与技能数量线性但很小，
 * 正文只在真正使用时进入上下文。
 */

export interface SkillInfo {
  /** 技能目录名（稳定 ID） */
  id: string
  /** frontmatter 中的 name，回退为目录名 */
  name: string
  /** frontmatter 中的 description */
  description: string
  /** SKILL.md 正文（已去 frontmatter；超长截断） */
  content: string
}

export interface SkillLoaderOptions {
  skillsPath?: string
  /** 启用的技能 ID 列表；undefined 表示全部启用 */
  enabledSkills?: string[]
}

/** 单个技能正文的加载上限（skill 工具返回给模型的正文长度） */
const MAX_SKILL_CHARS = 32_000

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
    logger.warn('[Skills] Failed to scan skills directory:', err)
  }
  return skills
}

/**
 * 技能索引段（系统提示词）：只列名字、ID 与描述，并告诉模型用 `skill` 工具加载正文。
 *
 * 每项固定格式，便于模型精确传参：`- <name> (<id>): <description>`。
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

/** 按名字或 ID 查找技能（名字比较忽略大小写；ID 精确匹配优先） */
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

