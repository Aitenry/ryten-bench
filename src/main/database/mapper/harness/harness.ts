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

// --- Type definitions ---

/** Workspace row (fields inferred from the schema) */
export type WorkspaceRow = typeof workspace.$inferSelect

/** Dialogue usage row (fields inferred from the schema): one row per assistant reply */
export type HarnessDialogueUsageRow = typeof harness_dialogue_usage.$inferSelect

/** Topic (conversation) row */
export type HarnessTopicRow = typeof harness_topic.$inferSelect

/** Dialogue record row (the role union type is provided by the schema's $type) */
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
  /** Workspace kind: 'user' (default, a directory the user picked in work mode) / 'plugin' / 'chat' */
  kind: WorkspaceKind = 'user'
): Promise<number> {
  return withOrm('createWorkspace', async (db) => {
    const rows = await db
      .insert(workspace)
      .values({ name, path, kind })
      .returning({ id: workspace.id })
    const newId = rows[0].id
    logger.info(`Created workspace ID=${newId}, name="${name}", path="${path}", kind=${kind}`)
    // Documents/knowledge bases/todos are global data (not owned by any workspace), so no
    // existing data needs migrating
    return newId
  })
}

/**
 * Change a workspace's kind (only used to "claim existing rows": the historical batch of plugin
 * workspaces was created before 0010 and has the default kind 'user', so they are classified in
 * place when plugin workspaces are fetched; the startup migrateWorkspaceData also puts them in
 * place by path in one pass). Path and name are untouched, so updated_at is not refreshed.
 */
async function setWorkspaceKind(id: number, kind: WorkspaceKind): Promise<boolean> {
  return withOrm('setWorkspaceKind', async (db) => {
    const updated = await db
      .update(workspace)
      .set({ kind })
      // ⚠️ `ne(kind, 'plugin')` is NULL (not true) for NULL rows: if a pre-0010 database was
      // edited by hand or a migration left NULLs, claiming would silently do nothing. Treat NULL
      // as "needs classification" explicitly.
      .where(and(eq(workspace.id, id), or(isNull(workspace.kind), ne(workspace.kind, kind))))
      .returning({ id: workspace.id })
    if (updated.length > 0) {
      logger.info(`Workspace ID=${id} classified as kind=${kind}`)
    }
    return updated.length > 0
  })
}

/** Fetch one workspace row by id (null if not found): used to fall back to the memory scope by workspace kind when creating a topic */
async function getWorkspaceById(id: number): Promise<WorkspaceRow | null> {
  return withOrm('getWorkspaceById', async (db) => {
    const rows = await db.select().from(workspace).where(eq(workspace.id, id)).limit(1)
    return rows[0] ?? null
  })
}

/** Find one workspace row by path (null if not found): used for plugin workspace claiming and chat directory checks */
async function findWorkspaceByPath(path: string): Promise<WorkspaceRow | null> {
  return withOrm('findWorkspaceByPath', async (db) => {
    const rows = await db.select().from(workspace).where(eq(workspace.path, path)).limit(1)
    return rows[0] ?? null
  })
}

/** Workspaces of one kind (the sidebar splits by kind: user → work list, plugin / chat → their respective modes) */
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
 * Change a workspace path (after the storage root is relocated, so old sessions follow to the new
 * location).
 *
 * Only called by `storage/workspace-refs.ts`: it checks for duplicates first (`workspace_path_key`
 * has a unique constraint) and then updates rows one by one; this keeps the minimal "change one
 * field" semantics.
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
      // Allows deleting the last workspace: the app no longer creates a default workspace
      // automatically and returns to "unconfigured" once all are gone, with the chat page
      // prompting the user to pick a directory again.
      // Only workspace-private content is cleaned up (chat topics / subagent config / memory
      // directories)
      // Documents / knowledge bases / todos / plans / playlists are all global data, not owned by
      // any workspace, and are not deleted with it
      // Fix: harness_goals and topic_compactions have no foreign-key cascade (neither 023 nor 024
      // has REFERENCES), so goal rows and compaction checkpoints would remain orphaned forever
      // after the workspace is deleted — delete them by enumerating topics first
      const topicIds = tx
        .select({ id: harness_topic.id })
        .from(harness_topic)
        .where(eq(harness_topic.workspace_id, id))
      await tx.delete(harness_goals).where(inArray(harness_goals.topic_id, topicIds))
      await tx.delete(topic_compactions).where(inArray(topic_compactions.topic_id, topicIds))
      // Chat topics and subagent config have foreign-key cascades, so deleting the workspace row
      // suffices
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
 * Topic list order: unarchived first (archived sink to the bottom) → pinned first → the rest by
 * activity time descending.
 *
 * Why raw SQL fragments: the NULL placement of `desc(pinned_at)` is not what we want — pinned
 * (non-NULL) must come first and unpinned (NULL) after. Sorting by the "is not null" boolean is
 * the most direct; archived works the same way with the opposite direction. Neither pinning nor
 * archiving touches `updated_at`, so after un-pinning/un-archiving a topic returns to its
 * original activity position.
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
 * Archived topics across all workspaces (for the "Archived" group at the bottom of the sidebar).
 *
 * Not scoped to a workspace: archived topics are collected in one place in the sidebar (per the
 * user's 2026-11-25 decision), and the list needs each topic's workspace name, so rows carry
 * `workspace_id` and the renderer resolves the name. Ordered by archive time descending.
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
    // Clamp page size to ≥1 (fix: pageSize 0/negative produced an empty LIMIT 0 page with hasMore
    // always true)
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
 * Move historical sessions of a plugin scope under that plugin's workspace.
 *
 * Purpose: plugin sessions getting "their own working directory" was only added on 2026-09-28;
 * plugin sessions created before that (already `plugin:<id>` on the topic, but with workspace_id
 * still pointing at the workspace of the time) kept borrowing the work-mode workspace — exactly
 * the bug the user reported. Reparenting them when plugin workspaces are fetched makes old
 * sessions land in the plugin directory the next time they are opened.
 *
 * Does not touch `updated_at`: it is the topic list sort key, and moving house should not push old
 * sessions to the top.
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
  /** Memory scope (`plugin:<plugin id>`; empty = workspace memory, see main/memory-scope.ts) */
  memoryScope?: string | null,
  /**
   * Team collaboration toggle (Agent Teams): persisted together with the topic.
   * The toggle clicked in a blank conversation is a "draft" and the topic is only created with
   * the first message, so it must be written here in one go — creating first and updating later
   * would make the UI flash "off then on" and leave a fallible intermediate state.
   */
  teamMode?: boolean
): Promise<number> {
  return withOrm('createTopic', async (db) => {
    const rows = await db
      .insert(harness_topic)
      .values({
        workspace_id: workspaceId,
        title,
        model: model || null,
        selected_tools: selectedTools || null,
        memory_scope: memoryScope || null,
        team_mode: teamMode === true
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
 * Pin / unpin.
 *
 * **Does not touch `updated_at`**: that is the "last active time" and the sort key among
 * unpinned topics. If this action changed it, unpinning would jump the topic to the front
 * instead of returning it to its original position.
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

/** Archive / unarchive (same reason: does not touch `updated_at`, so unarchiving returns to the original position) */
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
 * Read a topic's plan mode.
 *
 * A missing topic / failed query is always treated as "inactive": plan mode only affects the
 * prompt and tool list, and on a read failure it is better to lose a planning section than to
 * fail the whole request.
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
 * Write a topic's plan mode.
 *
 * Does not touch `updated_at`: plan mode is a switch inside the conversation and should not
 * push it to the top of the topic list.
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
 * A topic's Agent Teams toggle (opt-in).
 *
 * Same policy as plan_mode: a read failure is treated as "off" (team tools/prompts are an
 * enhancement, and it is better to lose team capabilities than to fail the whole request);
 * writing does not touch `updated_at`.
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
 * Fork a conversation: copy one conversation (topic row + all dialogues) into an
 * **independent** new one.
 *
 * What is copied is a data snapshot; afterwards the two proceed separately: the parent continuing
 * to chat will not affect the fork, and messages in the fork are not written back to the parent.
 * - `created_at` is preserved as is ⇒ the fork's history timeline matches the source; the new
 *   conversation's `updated_at` is now (so it sits at the top of the list and the user sees it
 *   immediately);
 * - pin / archive state is not copied (the fork is a new, normal conversation);
 * - the summary compaction checkpoint is not copied: it records the "last dialogue id of the
 *   compacted segment" pointing at a row of the source conversation, which would be wrong in the
 *   new one (better to compact again).
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

    // Paginate starting from the newest message: DESC order, reverse after fetching a page so the
    // caller gets oldest→newest
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
      // Fix: new messages must refresh the topic's activity time — previously updated_at was only
      // written when editing the title, so "activity order" was really "created/edited order"
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
 * Rewrite a dialogue's body in place (used by "edit and resend").
 *
 * Why it must be an UPDATE rather than "delete the old + insert a new": edit-and-resend refers to
 * the **same** question, and delete+insert would turn it into a new row in the database
 * (created_at becomes now) — the historical order moves to the end and the row id changes, so the
 * id the frontend holds immediately goes stale (deletion/usage look rows up by id). Changing the
 * content while keeping the id and position is correct.
 * Like addDialogue, it also refreshes the topic's activity time.
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

// --- harness_dialogue_usage (actual dialogue usage) ---

/** Write a dialogue usage row; repeated writes for the same dialogue are ignored (dialogue_id is unique) */
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
 * Fetch **only the last** usage row of the topic (performance audit P09).
 *
 * Estimating the "real context tokens of the previous round" at the start of each dialogue round
 * only needs the last row; the old implementation called `getUsageByTopic` here to read
 * everything (hundreds of rows for long sessions, including the usage_metadata JSON) and then
 * took the last one. The renderer still backfills usage through the full `getUsageByTopic` API,
 * so its semantics are unchanged.
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

/** Usage detail for a topic (the renderer backfills it into each message by dialogue_id) */
async function getUsageByTopic(topicId: number): Promise<HarnessDialogueUsageRow[]> {
  return withOrm('getUsageByTopic', async (db) => {
    return db
      .select()
      .from(harness_dialogue_usage)
      .where(eq(harness_dialogue_usage.topic_id, topicId))
      .orderBy(asc(harness_dialogue_usage.id))
  })
}

/** Aggregate usage by workspace (grouped by provider + model, for billing/statistics) */
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

/** One search hit across topics (including the title of its topic) */
export interface HarnessDialogueSearchRow {
  id: number
  topic_id: number
  role: string
  content: string
  created_at: string | null
  topic_title: string | null
}

/**
 * Search historical messages across topics (isolated per workspace).
 *
 * - `%` / `_` / `\` in `query` are escaped: user input is literal text, not LIKE wildcards;
 * - only topics in the **current workspace** are returned (searching across workspaces would
 *   bring in the history of other projects);
 * - newest first, capped at 50 hits, which is enough for the model to locate "which conversation
 *   discussed this"; details are then read per topic.
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
