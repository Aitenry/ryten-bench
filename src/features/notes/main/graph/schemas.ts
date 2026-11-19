/**
 * 知识图谱 Zod 数据模式 —— 定义所有 LLM 输出的结构化契约
 * 配合 StructuredOutputParser 使用，实现 JSON 输出的强制校验
 */
import { z } from 'zod/v3'

/** 实体类型枚举值（按领域分组，覆盖全行业） */
const ENTITY_TYPES = [
  // 通用
  'person', // 人物
  'organization', // 组织
  'concept', // 概念/理论
  'event', // 事件
  'location', // 地点
  'other', // 其他
  // 技术/IT
  'technology', // 技术/工具
  'product', // 产品/项目
  'system', // 体系/平台/系统（管理体系、IT系统、业务平台）
  // 法规/合规
  'document', // 文档/证照（合同、许可证、证书、报告、法律文书）
  'standard', // 标准/法规/政策（技术标准、行业规范、法律法规、政策文件）
  // 制造/工程
  'facility', // 设施/装备（核设施、生产设备、建筑、基础设施）
  'substance', // 物质/材料（化学物质、放射性核素、原材料、药品）
  'process', // 流程/工序/方法（工作流程、操作步骤、制造工序）
  // 人力资源
  'role', // 角色/职位/岗位
  'skill', // 技能/能力
  // 数据/分析
  'measure', // 指标/度量/参数（KPI、技术指标、监测数据）
  // 叙事/小说
  'artifact', // 物品/装备
  'creature', // 生物/物种
  'realm' // 等级/位阶
] as const

/** 允许的实体类型集合（用于后处理过滤，O(1) 查找） */
export const ALLOWED_ENTITY_TYPES: ReadonlySet<string> = new Set(ENTITY_TYPES)

/**
 * 单个实体（宽松化：type/confidence 的非法值由抽取后处理逐条兜底——
 * 修复：此前严格 enum/min-max 校验,一条非法即整块 JSON parse 失败,整块抽取静默丢弃,
 * 而后续的逐条过滤逻辑永远执行不到）
 */
export const EntitySchema = z.object({
  name: z.string().describe('canonical full name of the entity'),
  type: z.string().describe('entity type'),
  description: z.string().optional().describe('a concise description (≤ 15 words)'),
  confidence: z
    .number()
    .optional()
    .describe('confidence from 0 to 1, indicating how certain the entity extraction is')
})

/** 实体数组 —— 实体抽取 & Gleaning 使用 */
export const EntitiesArraySchema = z.array(EntitySchema)

/** 合并后的实体（含别名等元信息） */
export const MergedEntitySchema = z.object({
  name: z.string().describe('canonical name'),
  type: z.string().describe('entity type'),
  description: z.string().optional().describe('combined description'),
  aliases: z.array(z.string()).optional().describe('list of aliases'),
  confidence: z.number().optional().describe('confidence from 0 to 1'),
  source_doc_ids: z.array(z.number()).optional().describe('list of source document IDs')
})

/** 实体消歧合并结果 */
export const EntityMergingResultSchema = z.object({
  merged: z.array(MergedEntitySchema).describe('list of merged entities'),
  removed_names: z.array(z.string()).describe('list of names that were merged away')
})

/** 关系类型枚举值（按场景分组，覆盖全行业） */
const RELATION_TYPES = [
  // 结构与层次
  'contains', // A 包含 B
  'part_of', // A 是 B 的一部分
  'is_a', // A 是 B 的一种（继承/实例）
  'located_in', // A 位于 B
  // 依赖与因果
  'depends_on', // A 依赖 B
  'related_to', // A 与 B 相关（通用关联）
  'leads_to', // A 导致/产生 B
  // 生产与使用
  'uses', // A 使用/采用 B
  'creates', // A 创造/开发了 B
  'produces', // A 生产/制造/产出 B
  'operates', // A 运营/操作/运行 B
  // 所有与控制
  'owns', // A 拥有/持有 B
  'acquires', // A 获得/得到 B
  'belongs_to', // A 归属/属于 B（组织、团体、阵营）
  // 管理与监督
  'governs', // A 管辖/监管/治理 B
  'monitors', // A 监测/监控/监督 B
  // 人力与培训
  'employs', // A 雇用/聘用 B
  'mentors', // A 指导/教导/培训 B
  // 叙事/小说专用
  'friend_of', // A 与 B 是朋友/盟友
  'enemy_of', // A 与 B 是敌人/对手
  'loves', // A 爱慕/喜欢 B
  'family_of', // A 与 B 是亲属
  'fights', // A 与 B 交战/冲突/对抗
  'kills' // A 杀死/击败/淘汰 B
] as const

/** 允许的关系类型集合（用于后处理过滤，O(1) 查找） */
export const ALLOWED_RELATION_TYPES: ReadonlySet<string> = new Set(RELATION_TYPES)

/** 单个关系（宽松化：relation_type 非法值由后处理过滤,不再整块 parse 失败） */
export const RelationSchema = z.object({
  source: z.string().describe('source entity name'),
  target: z.string().describe('target entity name'),
  relation_type: z.string().describe('relation type'),
  description: z.string().optional().describe('a short relation description (≤ 15 words)')
})

/** 关系数组 —— 关系抽取使用 */
export const RelationsArraySchema = z.array(RelationSchema)

/** 统一抽取结果（实体+关系同时输出） */
export const UnifiedExtractionSchema = z.object({
  entities: z.array(EntitySchema).describe('list of extracted entities'),
  relations: z.array(RelationSchema).describe('list of extracted relations')
})

// ========== 类型推导 ==========
export type EntityOutput = z.infer<typeof EntitySchema>
export type EntitiesArrayOutput = z.infer<typeof EntitiesArraySchema>
export type MergedEntityOutput = z.infer<typeof MergedEntitySchema>
export type EntityMergingResultOutput = z.infer<typeof EntityMergingResultSchema>
export type RelationOutput = z.infer<typeof RelationSchema>
export type RelationsArrayOutput = z.infer<typeof RelationsArraySchema>
export type UnifiedExtractionOutput = z.infer<typeof UnifiedExtractionSchema>
