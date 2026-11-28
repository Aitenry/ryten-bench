import { eq, sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm, type Orm } from '../../orm'
import { node_positions } from '../../schema'

/** Canvas node position row (fields inferred from schema) */
export type NodePosition = typeof node_positions.$inferSelect

/** Upsert a single row (overwrites x/y and updated_at on a node_id primary-key conflict); timestamps always use the database clock */
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

// --- Get all node positions ---
async function getAllNodePositions(): Promise<NodePosition[]> {
  return withOrm('getAllNodePositions', async (db) => {
    const rows = await db.select().from(node_positions)
    logger.info(`Query for all node positions returned ${rows.length} rows.`)
    return rows
  })
}

// --- Save a single node position (upsert) ---
async function saveNodePosition(nodeId: string, x: number, y: number): Promise<void> {
  await withOrm('saveNodePosition', async (db) => {
    await upsertPosition(db, { node_id: nodeId, x, y })
    logger.info(`Saved node position: ${nodeId} -> (${x}, ${y})`)
  })
}

// --- Save node positions in bulk ---
async function saveNodePositions(
  positions: { node_id: string; x: number; y: number }[]
): Promise<void> {
  await withOrm('saveNodePositions', async (db) => {
    // Bulk write in a single transaction (fix: N independent INSERTs without a transaction left a partial write on interruption)
    await db.transaction(async (tx) => {
      for (const pos of positions) {
        await upsertPosition(tx, pos)
      }
    })
    logger.info(`Batch saved ${positions.length} node positions.`)
  })
}

// --- Delete a single node position ---
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
