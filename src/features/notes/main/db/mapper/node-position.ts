import { eq, sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm, type Orm } from '../../../../../main/database/orm'
import { node_positions } from '../../../../../main/database/schema'

/** 画布节点坐标行（字段由 schema 推导） */
export type NodePosition = typeof node_positions.$inferSelect

/** 单条 upsert（node_id 主键冲突时覆盖 x/y 与 updated_at），时间一律走数据库时钟 */
async function upsertPosition(
  db: Orm,
  pos: { node_id: string; x: number; y: number }
): Promise<void> {
  await db
    .insert(node_positions)
    .values({ node_id: pos.node_id, x: pos.x, y: pos.y, updated_at: sql`now()` })
    .onConflictDoUpdate({
      target: node_positions.node_id,
      set: { x: pos.x, y: pos.y, updated_at: sql`now()` }
    })
}

// --- 获取所有节点位置 ---
async function getAllNodePositions(): Promise<NodePosition[]> {
  return withOrm('getAllNodePositions', async (db) => {
    const rows = await db.select().from(node_positions)
    logger.info(`Query for all node positions returned ${rows.length} rows.`)
    return rows
  })
}

// --- 保存单个节点位置（upsert） ---
async function saveNodePosition(nodeId: string, x: number, y: number): Promise<void> {
  await withOrm('saveNodePosition', async (db) => {
    await upsertPosition(db, { node_id: nodeId, x, y })
    logger.info(`Saved node position: ${nodeId} -> (${x}, ${y})`)
  })
}

// --- 批量保存节点位置 ---
async function saveNodePositions(
  positions: { node_id: string; x: number; y: number }[]
): Promise<void> {
  await withOrm('saveNodePositions', async (db) => {
    // 单事务批量写入（修复：N 条独立 INSERT 无事务,中断即半写）
    await db.transaction(async (tx) => {
      for (const pos of positions) {
        await upsertPosition(tx, pos)
      }
    })
    logger.info(`Batch saved ${positions.length} node positions.`)
  })
}

// --- 删除单个节点位置 ---
async function deleteNodePosition(nodeId: string): Promise<boolean> {
  return withOrm('deleteNodePosition', async (db) => {
    const deleted = await db
      .delete(node_positions)
      .where(eq(node_positions.node_id, nodeId))
      .returning({ node_id: node_positions.node_id })
    if (deleted.length > 0) {
      logger.info(`Deleted node position: ${nodeId}`)
      return true
    }
    return false
  })
}

export { getAllNodePositions, saveNodePosition, saveNodePositions, deleteNodePosition }
