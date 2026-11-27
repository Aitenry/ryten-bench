/**
 * 技能加载与索引的回归测试（`runtime/harness/skills-core.ts`，纯逻辑、不启动 Electron）。
 *
 * 跑法：`node --no-warnings tests/skills.test.mts`
 *
 * 覆盖：
 * - SKILL.md frontmatter 解析（name/description）与正文去 frontmatter；
 * - enabledSkills 过滤（按目录 ID）；
 * - 系统提示词只放索引（名字/ID/描述 + "用 skill 工具加载"），**不放正文**；
 * - 按名字 / ID 查找（名字忽略大小写）；
 * - 超长正文按上限截断并带标记。
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildSkillsPromptSection,
  findSkill,
  loadSkills
} from '../src/main/runtime/harness/skills-core.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-skills-'))
const writeSkill = (dir: string, content: string): void => {
  fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.writeFileSync(path.join(root, dir, 'SKILL.md'), content, 'utf-8')
}

writeSkill(
  'pdf-helper',
  `---
name: PDF Helper
description: Extract text and tables from PDF files
---
# PDF Helper
Do the PDF thing with ` + '```bash\npdftotext in.pdf out.txt\n```'
)
writeSkill(
  'writer',
  `---
name: Writer
description: Write polished prose
---
# Writer
Write well.
`
)
// 没有 frontmatter 的技能：name 回退为目录名
writeSkill('plain-skill', '# Plain\nJust some instructions.')

const all = loadSkills({ skillsPath: root })
assert.equal(all.length, 3)
const pdf = all.find((skill) => skill.id === 'pdf-helper')
assert.ok(pdf)
assert.equal(pdf?.name, 'PDF Helper')
assert.equal(pdf?.description, 'Extract text and tables from PDF files')
assert.ok(pdf?.content.startsWith('# PDF Helper'))
assert.ok(!pdf?.content.includes('description:'), 'frontmatter must not leak into the body')
const plain = all.find((skill) => skill.id === 'plain-skill')
assert.equal(plain?.name, 'plain-skill')
assert.equal(plain?.description, '')

// enabledSkills 过滤（按目录 ID）
const filtered = loadSkills({ skillsPath: root, enabledSkills: ['writer'] })
assert.deepEqual(filtered.map((skill) => skill.id), ['writer'])

// 未配置目录 / 不存在的目录 → 空列表，不抛错
assert.deepEqual(loadSkills({}), [])
assert.deepEqual(loadSkills({ skillsPath: path.join(root, 'missing') }), [])

// 系统提示词：只有索引，没有正文
const section = buildSkillsPromptSection(all)
assert.ok(section.includes('PDF Helper (pdf-helper)'))
assert.ok(section.includes('Extract text and tables from PDF files'))
assert.ok(section.includes('skill'))
assert.ok(!section.includes('pdftotext'), 'skill body must not be injected into the prompt')
assert.ok(!section.includes('# PDF Helper'), 'skill body must not be injected into the prompt')
assert.equal(buildSkillsPromptSection([]), '')

// 查找：名字忽略大小写、ID 优先、未知返回 undefined
assert.equal(findSkill(all, 'pdf helper')?.id, 'pdf-helper')
assert.equal(findSkill(all, 'pdf-helper')?.id, 'pdf-helper')
assert.equal(findSkill(all, 'PDF HELPER')?.id, 'pdf-helper')
assert.equal(findSkill(all, 'unknown'), undefined)

// 超长正文按上限截断并带标记
const longBody = 'x'.repeat(40_000)
writeSkill('long-skill', `---\nname: Long\ndescription: long one\n---\n${longBody}`)
const longSkill = loadSkills({ skillsPath: root, enabledSkills: ['long-skill'] })[0]
assert.ok(longSkill.content.length <= 32_000 + 32)
assert.ok(longSkill.content.endsWith('... (truncated)'))

fs.rmSync(root, { recursive: true, force: true })
console.log('skills: all assertions passed')
