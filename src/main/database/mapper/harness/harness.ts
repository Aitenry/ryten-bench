import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import { withOrm } from '../../orm'
import {
  harness_dialogue,
  harness_dialogue_usage,
  harness_goals,
  harness_topic,
  topic_compactions,
  workspace
} from '../../schema'
import type { WorkspaceKind } from '../../schema/workspace'

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

async function createWorkspace(
  name: string,
  path: string,
  /** 工作区种类：'user'（默认，工作模式里用户自己选的目录）/ 'plugin' / 'chat' */
  kind: WorkspaceKind = 'user'
): Promise<number> {
  return withOrm('createWorkspace', async (db) => {
    const rows = await db
      .insert(workspace)
      .values({ name, path, kind })
      .returning({ id: workspace.id })
    const newId = rows[0].id
    logger.info(`Created workspace ID=${newId}, name="${name}", path="${path}", kind=${kind}`)
    // 文档/知识库/待办为全局数据（不属于任一工作区），无需承接存量
    return newId
  })
}

/**
 * 改工作区种类（只给「认领已有行」用：历史上那批插件工作区是 0010 之前建的，
 * 它们的 kind 是默认的 'user'，取插件工作区时顺手就地分类；启动时的 migrateWorkspaceData
 * 也会按路径把它们一次性归位）。路径与名字都不动，因此不刷 updated_at。
 */
async function setWorkspaceKind(id: number, kind: WorkspaceKind): Promise<boolean> {
  return withOrm('setWorkspaceKind', async (db) => {
    const updated = await db
      .update(workspace)
      .set({ kind })
      // ⚠️ `ne(kind, 'plugin')` 对 NULL 行是 NULL（不是 true）：0010 之前若有人手写库或
      // 迁移异常留下 NULL，认领会静默不生效。显式把 NULL 也算成「需要分类」。
      .where(and(eq(workspace.id, id), or(isNull(workspace.kind), ne(workspace.kind, kind))))
      .returning({ id: workspace.id })
    if (updated.length > 0) {
      logger.info(`Workspace ID=${id} classified as kind=${kind}`)
    }
    return updated.length > 0
  })
}

/** 按 id 取一行工作区（找不到返回 null）：建话题时按工作区种类兜底记忆作用域用它 */
async function getWorkspaceById(id: number): Promise<WorkspaceRow | null> {
  return withOrm('getWorkspaceById', async (db) => {
    const rows = await db.select().from(workspace).where(eq(workspace.id, id)).limit(1)
    return rows[0] ?? null
  })
}

/** 按路径找一行工作区（找不到返回 null）：插件工作区认领、chat 目录核对都用它 */
async function findWorkspaceByPath(path: string): Promise<WorkspaceRow | null> {
  return withOrm('findWorkspaceByPath', async (db) => {
    const rows = await db.select().from(workspace).where(eq(workspace.path, path)).limit(1)
    return rows[0] ?? null
  })
}

/** 某一类工作区（侧栏按 kind 分流：user → 工作列表，plugin / chat → 各自的模式） */
async function getWorkspacesByKind(kind: WorkspaceKind): Promise<WorkspaceRow[]> {
  return withOrm('getWorkspacesByKind', async (db) => {
    return db
      .select()
      .from(workspace)
      .where(eq(workspace.kind, kind))
      .orderBy(asc(workspace.created_at))
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

/**
 * 改工作区路径（存储根整体搬迁后，让旧会话跟到新位置）。
 *
 * 只由 `storage/workspace-refs.ts` 调用：它先查重（`workspace_path_key` 有唯一约束），
 * 再逐行改；这里保持「只改一个字段」的最小语义。
 */
async function updateWorkspacePath(id: number, nextPath: string): Promise<boolean> {
  return withOrm('updateWorkspacePath', async (db) => {
    const updated = await db
      .update(workspace)
      .set({ path: nextPath, updated_at: sql`now()` })
      .where(eq(workspace.id, id))
      .returning({ id: workspace.id })
    logger.info(
      `Updated workspace ID=${id} path="${nextPath}", ${updated.length} row(s) affected.`
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

/**
 * 会话列表排序：未归档在前（归档的沉底）→ 置顶在前 → 其余按活跃时间倒序。
 *
 * 为什么要写成 SQL 片段：`desc(pinned_at)` 的 NULL 位置不是我们要的——置顶（非 NULL）
 * 必须先出现、未置顶（NULL）在后。按「is not null」的布尔值排最直接；归档同理，方向相反。
 * 置顶 / 归档两个动作都不改 `updated_at`，所以取消之后会回到它原来的活跃位置。
 */
const topicOrderBy = [
  sql`${harness_topic.archived_at} is not null asc`,
  sql`${harness_topic.pinned_at} is not null desc`,
  desc(harness_topic.updated_at)
]

async function getAllTopics(workspaceId: number): Promise<HarnessTopicRow[]> {
  return withOrm('getAllTopics', async (db) => {
    const rows = await db
      .select()
      .from(harness_topic)
      .where(eq(harness_topic.workspace_id, workspaceId))
      .orderBy(...topicOrderBy)
    logger.info(
      `Query for harness topics in workspace=${workspaceId} returned ${rows.length} rows.`
    )
    return rows
  })
}

/**
 * 所有工作区里已归档的会话（侧栏底部的「已归档」分组用）。
 *
 * 不分工作区：归档的会话统一收在侧栏一处（用户 2026-11-25 口径），列表要能看到它们的
 * 工作区名字，所以行里带 `workspace_id`，由渲染层配名字。按归档时间倒序。
 */
async function getArchivedTopics(): Promise<HarnessTopicRow[]> {
  return withOrm('getArchivedTopics', async (db) => {
    const rows = await db
      .select()
      .from(harness_topic)
      .where(sql`${harness_topic.archived_at} is not null`)
      .orderBy(desc(harness_topic.archived_at))
    logger.info(`Query for archived harness topics returned ${rows.length} rows.`)
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
      .orderBy(...topicOrderBy)
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

/**
 * 把某插件作用域的历史会话收拢到它的插件工作区下。
 *
 * 用途：插件会话「有自己的工作目录」是 2026-09-28 才补上的，在那之前开出来的插件会话
 * （话题上已经是 `plugin:<id>`，但 workspace_id 还指着当时的工作区）会继续借用工作模式那个
 * 工作区——正是用户报的那个 bug。取插件工作区时顺手归位，老会话下次打开就落在插件目录上。
 *
 * 不动 `updated_at`：那是会话列表的排序键，搬家不该把老会话顶到最前面。
 */
async function reparentPluginTopics(workspaceId: number, memoryScope: string): Promise<number> {
  return withOrm('reparentPluginTopics', async (db) => {
    const updated = await db
      .update(harness_topic)
      .set({ workspace_id: workspaceId })
      .where(
        and(
          eq(harness_topic.memory_scope, memoryScope),
          ne(harness_topic.workspace_id, workspaceId)
        )
      )
      .returning({ id: harness_topic.id })
    if (updated.length > 0) {
      logger.info(
        `Reparented ${updated.length} plugin topic(s) to workspace=${workspaceId} (${memoryScope})`
      )
    }
    return updated.length
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

/**
 * 置顶 / 取消置顶。
 *
 * **不动 `updated_at`**：那是「最近活跃时间」，也是未置顶会话之间的排序键。
 * 若这个动作顺手改了它，取消置顶后这条会话会跳到最前面，而不是回到它原来的位置。
 */
async function setTopicPinned(id: number, pinned: boolean): Promise<boolean> {
  return withOrm('setTopicPinned', async (db) => {
    const updated = await db
      .update(harness_topic)
      .set({ pinned_at: pinned ? sql`now()` : null })
      .where(eq(harness_topic.id, id))
      .returning({ id: harness_topic.id })
    logger.info(`Set harness topic ID=${id} pinned=${pinned}, ${updated.length} row(s) affected.`)
    return updated.length > 0
  })
}

/** 归档 / 取消归档（理由同上：不碰 `updated_at`，取消归档后回到原来的位置） */
async function setTopicArchived(id: number, archived: boolean): Promise<boolean> {
  return withOrm('setTopicArchived', async (db) => {
    const updated = await db
      .update(harness_topic)
      .set({ archived_at: archived ? sql`now()` : null })
      .where(eq(harness_topic.id, id))
      .returning({ id: harness_topic.id })
    logger.info(
      `Set harness topic ID=${id} archived=${archived}, ${updated.length} row(s) affected.`
    )
    return updated.length > 0
  })
}

/**
 * 读取话题的计划模式（plan mode）。
 *
 * 话题不存在 / 查询失败一律按「未激活」处理：计划模式只影响提示词与工具清单，
 * 读取失败时宁可少一段规划指引，也不能让整轮请求失败。
 */
async function getTopicPlanMode(id: number): Promise<boolean> {
  return withOrm('getTopicPlanMode', async (db) => {
    const rows = await db
      .select({ plan_mode: harness_topic.plan_mode })
      .from(harness_topic)
      .where(eq(harness_topic.id, id))
      .limit(1)
    return rows[0]?.plan_mode ?? false
  })
}

/**
 * 写入话题的计划模式。
 *
 * 不碰 `updated_at`：计划模式是会话内的一个开关，不应该把它顶到会话列表最前面。
 */
async function setTopicPlanMode(id: number, active: boolean): Promise<boolean> {
  return withOrm('setTopicPlanMode', async (db) => {
    const updated = await db
      .update(harness_topic)
      .set({ plan_mode: active })
      .where(eq(harness_topic.id, id))
      .returning({ id: harness_topic.id })
    logger.info(
      `Set harness topic ID=${id} plan_mode=${active}, ${updated.length} row(s) affected.`
    )
    return updated.length > 0
  })
}

/**
 * 话题的 Agent Teams 开关（opt-in）。
 *
 * 与 plan_mode 同一口径：读取失败按「关闭」处理（团队工具/提示词是增强能力，
 * 失败时宁可没有团队能力，也不能让整轮请求失败）；写入不碰 `updated_at`。
 */
async function getTopicTeamMode(id: number): Promise<boolean> {
  return withOrm('getTopicTeamMode', async (db) => {
    const rows = await db
      .select({ team_mode: harness_topic.team_mode })
      .from(harness_topic)
      .where(eq(harness_topic.id, id))
      .limit(1)
    return rows[0]?.team_mode ?? false
  })
}

async function setTopicTeamMode(id: number, enabled: boolean): Promise<boolean> {
  return withOrm('setTopicTeamMode', async (db) => {
    const updated = await db
      .update(harness_topic)
      .set({ team_mode: enabled })
      .where(eq(harness_topic.id, id))
      .returning({ id: harness_topic.id })
    logger.info(`Set harness topic ID=${id} team_mode=${enabled}, ${updated.length} row(s) affected.`)
    return updated.length > 0
  })
}

/**
 * 分叉会话：把一条会话（话题行 + 全部对话）复制成一条**独立的**新会话。
 *
 * 复制的是数据快照，之后两条会话各走各的：父会话继续聊不会改到分叉，分叉里发消息也不回写父会话。
 * - `created_at` 原样保留 ⇒ 分叉里的历史时间线与源会话一致；新会话的 `updated_at` 是现在
 *   （排在列表最前，用户点完立刻能看到它）；
 * - 不复制置顶 / 归档状态（分叉出来是一条新的、正常的会话）；
 * - 不复制摘要压缩 checkpoint：它记的是「已压缩段最后一条对话 id」，指向源会话的行，
 *   搬到新会话里就是错的（新会话宁可重新压缩一次）。
 */
async function forkTopic(sourceId: number, title: string): Promise<HarnessTopicRow | null> {
  return withOrm('forkTopic', async (db) => {
    const [source] = await db
      .select()
      .from(harness_topic)
      .where(eq(harness_topic.id, sourceId))
      .limit(1)
    if (!source) return null

    let forkedId = 0
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(harness_topic)
        .values({
          workspace_id: source.workspace_id,
          title,
          model: source.model,
          selected_tools: source.selected_tools,
          memory_scope: source.memory_scope
        })
        .returning({ id: harness_topic.id })
      forkedId = inserted[0].id

      const dialogues = await tx
        .select()
        .from(harness_dialogue)
        .where(eq(harness_dialogue.topic_id, sourceId))
        .orderBy(asc(harness_dialogue.created_at), asc(harness_dialogue.id))
      if (dialogues.length > 0) {
        await tx.insert(harness_dialogue).values(
          dialogues.map((row) => ({
            topic_id: forkedId,
            role: row.role,
            content: row.content,
            blocks: row.blocks,
            created_at: row.created_at
          }))
        )
      }
    })

    const [forked] = await db
      .select()
      .from(harness_topic)
      .where(eq(harness_topic.id, forkedId))
      .limit(1)
    logger.info(
      `Forked harness topic ${sourceId} -> ${forkedId} (${title})${forked ? `, workspace=${forked.workspace_id}` : ''}`
    )
    return forked ?? null
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

/**
 * 只取该话题**最后一条**用量行（性能审计 P09）。
 *
 * 每轮对话开头估算「上一轮真实上下文 token」只需要最后一行；旧实现在这里
 * `getUsageByTopic` 全量读出（长会话数百行、含 usage_metadata JSON）再取最后一条。
 * 渲染层回填用量仍走 `getUsageByTopic` 全量接口，语义不变。
 */
async function getLastUsageByTopic(topicId: number): Promise<HarnessDialogueUsageRow | null> {
  return withOrm('getLastUsageByTopic', async (db) => {
    const rows = await db
      .select()
      .from(harness_dialogue_usage)
      .where(eq(harness_dialogue_usage.topic_id, topicId))
      .orderBy(desc(harness_dialogue_usage.id))
      .limit(1)
    return rows[0] ?? null
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

/** 跨话题搜索的一条命中（含所属话题标题） */
export interface HarnessDialogueSearchRow {
  id: number
  topic_id: number
  role: string
  content: string
  created_at: string | null
  topic_title: string | null
}

/**
 * 跨话题搜索历史消息（按工作区隔离）。
 *
 * - `query` 里的 `%` / `_` / `\` 会被转义：用户输入是文本，不是 LIKE 通配符；
 * - 只返回**当前工作区**的话题（跨工作区搜索会把别的项目的历史带进来）；
 * - 按时间倒序、上限 50 条，够模型定位「哪次会话聊过」即可，详情再按话题读。
 */
async function searchDialogues(
  workspaceId: number,
  query: string,
  limit = 20
): Promise<HarnessDialogueSearchRow[]> {
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`)
  const pattern = `%${escaped}%`
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)))
  return withOrm('searchDialogues', async (db) => {
    return db
      .select({
        id: harness_dialogue.id,
        topic_id: harness_dialogue.topic_id,
        role: harness_dialogue.role,
        content: harness_dialogue.content,
        created_at: harness_dialogue.created_at,
        topic_title: harness_topic.title
      })
      .from(harness_dialogue)
      .innerJoin(harness_topic, eq(harness_dialogue.topic_id, harness_topic.id))
      .where(
        and(
          eq(harness_topic.workspace_id, workspaceId),
          ilike(harness_dialogue.content, pattern)
        )
      )
      .orderBy(desc(harness_dialogue.created_at))
      .limit(safeLimit)
  })
}

export {
  getAllWorkspaces,
  createWorkspace,
  setWorkspaceKind,
  getWorkspaceById,
  findWorkspaceByPath,
  getWorkspacesByKind,
  updateWorkspace,
  updateWorkspacePath,
  deleteWorkspace,
  getAllTopics,
  getAllTopicsPaginated,
  getArchivedTopics,
  getTopicById,
  reparentPluginTopics,
  createTopic,
  updateTopic,
  deleteTopic,
  setTopicPinned,
  setTopicArchived,
  getTopicPlanMode,
  setTopicPlanMode,
  getTopicTeamMode,
  setTopicTeamMode,
  forkTopic,
  getDialoguesByTopicId,
  getDialoguesByTopicIdPaginated,
  searchDialogues,
  addDialogue,
  updateDialogueContent,
  deleteDialoguesByTopicId,
  deleteDialogueById,
  addDialogueUsage,
  getUsageByTopic,
  getLastUsageByTopic,
  getUsageSummaryByWorkspace
}
