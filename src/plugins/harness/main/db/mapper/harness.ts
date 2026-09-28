import { asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import { withOrm } from '../../../../../main/database/orm'
import {
  harness_dialogue,
  harness_dialogue_usage,
  harness_goals,
  harness_topic,
  topic_compactions,
  workspace
} from '../../../../../main/database/schema'

// --- 类型定义 ---

/** 工作区行（字段由 schema 推导） */
export type WorkspaceRow = typeof workspace.$inferSelect

/** 对话用量行（字段由 schema 推导）：一条助手回复一行 */
export type HarnessDialogueUsageRow = typeof harness_dialogue_usage.$inferSelect

/** 会话（话题）行 */
export type HarnessTopicRow = typeof harness_topic.$inferSelect

/** 对话记录行（role 的联合类型由 schema 的 $type 提供） */
export type HarnessDialogueRow = typeof harness_dialogue.$inferSelect

export interface PaginatedResult<T> {
  items: T[]
  hasMore: boolean
  total: number
}

// --- workspace CRUD ---

async function getAllWorkspaces(): Promise<WorkspaceRow[]> {
  return withOrm('getAllWorkspaces', async (db) => {
    const rows = await db.select().from(workspace).orderBy(asc(workspace.created_at))
    logger.info(`Query for all workspaces returned ${rows.length} rows.`)
    return rows
  })
}

async function createWorkspace(name: string, path: string): Promise<number> {
  return withOrm('createWorkspace', async (db) => {
    const rows = await db.insert(workspace).values({ name, path }).returning({ id: workspace.id })
    const newId = rows[0].id
    logger.info(`Created workspace ID=${newId}, name="${name}", path="${path}"`)
    // 文档/知识库/待办为全局数据（不属于任一工作区），无需承接存量
    return newId
  })
}

async function updateWorkspace(id: number, updates: { name: string }): Promise<boolean> {
  return withOrm('updateWorkspace', async (db) => {
    const updated = await db
      .update(workspace)
      .set({ name: updates.name, updated_at: sql`now()` })
      .where(eq(workspace.id, id))
      .returning({ id: workspace.id })
    logger.info(
      `Updated workspace ID=${id} name="${updates.name}", ${updated.length} row(s) affected.`
    )
    return updated.length > 0
  })
}

async function deleteWorkspace(id: number): Promise<boolean> {
  return withOrm('deleteWorkspace', async (db) => {
    await db.transaction(async (tx) => {
      // 允许删除最后一个工作区：应用不再自动创建默认工作区，删空后回到「未配置」，
      // 由对话页引导用户重新选择目录。
      // 只清理工作区私有内容（聊天话题 / 子代理配置 / 记忆目录）
      // 文档 / 知识库 / 待办 / 计划 / 歌单均为全局数据，不属于任一工作区，不随工作区删除
      // 修复：harness_goals 与 topic_compactions 表无外键级联（023/024 均无 REFERENCES），
      // 工作区删除后目标行与压缩 checkpoint 会成孤儿永久残留——先按话题枚举删除
      const topicIds = tx
        .select({ id: harness_topic.id })
        .from(harness_topic)
        .where(eq(harness_topic.workspace_id, id))
      await tx.delete(harness_goals).where(inArray(harness_goals.topic_id, topicIds))
      await tx.delete(topic_compactions).where(inArray(topic_compactions.topic_id, topicIds))
      // 聊天话题与子代理配置有外键级联，删除工作区行即可
      const deleted = await tx.delete(workspace).where(eq(workspace.id, id)).returning({
        id: workspace.id
      })
      logger.info(`Deleted workspace ID=${id}, ${deleted.length} row(s) affected.`)
    })
    return true
  })
}

// --- harness_topic CRUD ---

async function getAllTopics(workspaceId: number): Promise<HarnessTopicRow[]> {
  return withOrm('getAllTopics', async (db) => {
    const rows = await db
      .select()
      .from(harness_topic)
      .where(eq(harness_topic.workspace_id, workspaceId))
      .orderBy(desc(harness_topic.updated_at))
    logger.info(
      `Query for harness topics in workspace=${workspaceId} returned ${rows.length} rows.`
    )
    return rows
  })
}

async function getAllTopicsPaginated(
  workspaceId: number,
  page: number,
  pageSize: number
): Promise<PaginatedResult<HarnessTopicRow>> {
  return withOrm('getAllTopicsPaginated', async (db) => {
    const safePage = Number.isFinite(page) ? Math.floor(page) : 0
    // 页大小钳制 ≥1（修复：pageSize 传 0/负数 → LIMIT 0 空页且 hasMore 恒真）
    const safePageSize = Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20)
    const safeWorkspaceId = Number.isFinite(workspaceId) ? Math.floor(workspaceId) : 0

    const countRows = await db
      .select({ total: count() })
      .from(harness_topic)
      .where(eq(harness_topic.workspace_id, safeWorkspaceId))
    const total = Number(countRows[0]?.total) || 0

    const rows = await db
      .select()
      .from(harness_topic)
      .where(eq(harness_topic.workspace_id, safeWorkspaceId))
      .orderBy(desc(harness_topic.updated_at))
      .limit(safePageSize)
      .offset(safePage * safePageSize)

    logger.info(
      `Paginated topics: workspace=${workspaceId}, page=${page}, size=${pageSize}, got=${rows.length}, total=${total}`
    )
    return {
      items: rows,
      hasMore: (page + 1) * pageSize < total,
      total
    }
  })
}

async function getTopicById(id: number): Promise<HarnessTopicRow[]> {
  return withOrm('getTopicById', async (db) => {
    return db.select().from(harness_topic).where(eq(harness_topic.id, id))
  })
}

async function createTopic(
  workspaceId: number,
  title: string,
  model?: string,
  selectedTools?: string,
  /** 记忆作用域（`plugin:<插件 id>`；空 = 工作区记忆，见 main/memory-scope.ts） */
  memoryScope?: string | null
): Promise<number> {
  return withOrm('createTopic', async (db) => {
    const rows = await db
      .insert(harness_topic)
      .values({
        workspace_id: workspaceId,
        title,
        model: model || null,
        selected_tools: selectedTools || null,
        memory_scope: memoryScope || null
      })
      .returning({ id: harness_topic.id })
    const newId = rows[0].id
    logger.info(
      `Created harness topic ID=${newId} in workspace=${workspaceId}, title: ${title}${memoryScope ? `, memory=${memoryScope}` : ''}`
    )
    return newId
  })
}

async function updateTopic(
  id: number,
  updates: Partial<Pick<HarnessTopicRow, 'title' | 'model' | 'selected_tools'>>
): Promise<boolean> {
  return withOrm('updateTopic', async (db) => {
    const patch: PgUpdateSetSource<typeof harness_topic> = {}
    if (updates.title !== undefined) patch.title = updates.title
    if (updates.model !== undefined) patch.model = updates.model
    if (updates.selected_tools !== undefined) patch.selected_tools = updates.selected_tools

    if (Object.keys(patch).length === 0) {
      logger.warn('No fields to update for harness topic:', id)
      return false
    }

    patch.updated_at = sql`now()`
    const updated = await db
      .update(harness_topic)
      .set(patch)
      .where(eq(harness_topic.id, id))
      .returning({ id: harness_topic.id })

    logger.info(`Updated harness topic ID=${id}, ${updated.length} row(s) affected.`)
    return updated.length > 0
  })
}

async function deleteTopic(id: number): Promise<boolean> {
  return withOrm('deleteTopic', async (db) => {
    const deleted = await db
      .delete(harness_topic)
      .where(eq(harness_topic.id, id))
      .returning({ id: harness_topic.id })
    logger.info(`Deleted harness topic ID=${id}, ${deleted.length} row(s) affected.`)
    return deleted.length > 0
  })
}

// --- harness_dialogue CRUD ---

async function getDialoguesByTopicId(topicId: number): Promise<HarnessDialogueRow[]> {
  return withOrm('getDialoguesByTopicId', async (db) => {
    const rows = await db
      .select()
      .from(harness_dialogue)
      .where(eq(harness_dialogue.topic_id, topicId))
      .orderBy(asc(harness_dialogue.created_at))
    logger.info(`Query dialogues for topic=${topicId} returned ${rows.length} rows.`)
    return rows
  })
}

async function getDialoguesByTopicIdPaginated(
  topicId: number,
  page: number,
  pageSize: number
): Promise<PaginatedResult<HarnessDialogueRow>> {
  return withOrm('getDialoguesByTopicIdPaginated', async (db) => {
    const safePage = Number.isFinite(page) ? Math.floor(page) : 0
    const safePageSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : 20
    const safeTopicId = Number.isFinite(topicId) ? Math.floor(topicId) : 0

    const countRows = await db
      .select({ total: count() })
      .from(harness_dialogue)
      .where(eq(harness_dialogue.topic_id, safeTopicId))
    const total = Number(countRows[0]?.total) || 0

    // 从最新消息开始分页：DESC 排序，取一页后反转，上层得到 oldest→newest
    const rows = await db
      .select()
      .from(harness_dialogue)
      .where(eq(harness_dialogue.topic_id, safeTopicId))
      .orderBy(desc(harness_dialogue.created_at))
      .limit(safePageSize)
      .offset(safePage * safePageSize)
    const items = rows.reverse()

    logger.info(
      `Paginated dialogues: topic=${topicId}, page=${page}, size=${pageSize}, got=${items.length}, total=${total}`
    )
    return { items, hasMore: (page + 1) * pageSize < total, total }
  })
}

async function addDialogue(
  dialogue: Omit<HarnessDialogueRow, 'id' | 'created_at'>
): Promise<number> {
  return withOrm('addDialogue', async (db) => {
    const { topic_id, role, content, blocks } = dialogue
    let newId = 0
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(harness_dialogue)
        .values({ topic_id, role, content, blocks: blocks || null })
        .returning({ id: harness_dialogue.id })
      newId = rows[0].id
      // 修复：新消息要刷新话题活跃时间——此前 updated_at 只在编辑标题时写入，
      // 「活跃排序」实为「创建/编辑排序」
      await tx
        .update(harness_topic)
        .set({ updated_at: sql`now()` })
        .where(eq(harness_topic.id, topic_id))
    })
    logger.info(`Added dialogue ID=${newId} to topic=${topic_id}`)
    return newId
  })
}

/**
 * 就地改写一条对话的正文（「编辑并重发」用）。
 *
 * 为什么必须是 UPDATE 而不是「删掉旧的 + 插一条新的」：编辑重发的是**同一条**提问，
 * 删插会让它在库里变成一条新行（created_at 变成现在）——历史顺序被挪到末尾、行 id 也变了，
 * 前端手里的 id 随即失效（删除/用量都按 id 找行）。改内容、保 id、保位置才对。
 * 与 addDialogue 一样顺手刷新话题活跃时间。
 */
async function updateDialogueContent(id: number, content: string): Promise<boolean> {
  return withOrm('updateDialogueContent', async (db) => {
    let updated = false
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(harness_dialogue)
        .set({ content })
        .where(eq(harness_dialogue.id, id))
        .returning({ id: harness_dialogue.id, topicId: harness_dialogue.topic_id })
      updated = rows.length > 0
      if (rows[0]) {
        await tx
          .update(harness_topic)
          .set({ updated_at: sql`now()` })
          .where(eq(harness_topic.id, rows[0].topicId))
      }
    })
    logger.info(`Updated dialogue ID=${id} content (${content.length} chars)`)
    return updated
  })
}

async function deleteDialoguesByTopicId(topicId: number): Promise<boolean> {
  return withOrm('deleteDialoguesByTopicId', async (db) => {
    const deleted = await db
      .delete(harness_dialogue)
      .where(eq(harness_dialogue.topic_id, topicId))
      .returning({ id: harness_dialogue.id })
    logger.info(`Deleted ${deleted.length} dialogues for topic=${topicId}`)
    return deleted.length > 0
  })
}

async function deleteDialogueById(id: number): Promise<boolean> {
  return withOrm('deleteDialogueById', async (db) => {
    const deleted = await db
      .delete(harness_dialogue)
      .where(eq(harness_dialogue.id, id))
      .returning({ id: harness_dialogue.id })
    logger.info(`Deleted dialogue ID=${id}, ${deleted.length} row(s) affected.`)
    return deleted.length > 0
  })
}

// --- harness_dialogue_usage（对话真实用量） ---

/** 写入一条对话用量；同一对话重复写入直接忽略（dialogue_id 唯一） */
async function addDialogueUsage(
  usage: Omit<HarnessDialogueUsageRow, 'id' | 'created_at'>
): Promise<number | null> {
  return withOrm('addDialogueUsage', async (db) => {
    const rows = await db
      .insert(harness_dialogue_usage)
      .values(usage)
      .onConflictDoNothing({ target: harness_dialogue_usage.dialogue_id })
      .returning({ id: harness_dialogue_usage.id })
    const newId = rows[0]?.id ?? null
    logger.info(
      `Usage row for dialogue=${usage.dialogue_id} (topic=${usage.topic_id}): ${newId ?? 'skipped'}`
    )
    return newId
  })
}

/** 按话题取用量明细（渲染层按 dialogue_id 回填到各条消息） */
async function getUsageByTopic(topicId: number): Promise<HarnessDialogueUsageRow[]> {
  return withOrm('getUsageByTopic', async (db) => {
    return db
      .select()
      .from(harness_dialogue_usage)
      .where(eq(harness_dialogue_usage.topic_id, topicId))
      .orderBy(asc(harness_dialogue_usage.id))
  })
}

/** 按工作区聚合用量（按供应商 + 模型分组，用于账单/统计） */
async function getUsageSummaryByWorkspace(workspaceId: number): Promise<
  {
    provider: string | null
    model: string | null
    calls: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }[]
> {
  return withOrm('getUsageSummaryByWorkspace', async (db) => {
    const rows = await db
      .select({
        provider: harness_dialogue_usage.provider,
        model: harness_dialogue_usage.model,
        calls: sql<string>`coalesce(sum(${harness_dialogue_usage.calls}), 0)`,
        inputTokens: sql<string>`coalesce(sum(${harness_dialogue_usage.input_tokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${harness_dialogue_usage.output_tokens}), 0)`,
        totalTokens: sql<string>`coalesce(sum(${harness_dialogue_usage.total_tokens}), 0)`
      })
      .from(harness_dialogue_usage)
      .where(eq(harness_dialogue_usage.workspace_id, workspaceId))
      .groupBy(harness_dialogue_usage.provider, harness_dialogue_usage.model)
    return rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: Number(row.calls),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      totalTokens: Number(row.totalTokens)
    }))
  })
}

export {
  getAllWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getAllTopics,
  getAllTopicsPaginated,
  getTopicById,
  createTopic,
  updateTopic,
  deleteTopic,
  getDialoguesByTopicId,
  getDialoguesByTopicIdPaginated,
  addDialogue,
  updateDialogueContent,
  deleteDialoguesByTopicId,
  deleteDialogueById,
  addDialogueUsage,
  getUsageByTopic,
  getUsageSummaryByWorkspace
}
