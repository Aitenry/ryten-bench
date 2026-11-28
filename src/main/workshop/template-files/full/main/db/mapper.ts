import { desc, eq } from 'drizzle-orm'
import { withOrm } from '@host/main/database/orm'
import type { ${vars.pascal}Item, ${vars.pascal}ItemInput } from '../../shared/types'
import { schemaReady } from './ddl'
import { ${vars.itemsToolName}, type ${vars.pascal}ItemRow } from './schema'

/**
 * Data access layer for ${vars.title}.
 *
 * Rules (same as the host mapper):
 * - **every function awaits `schemaReady` first**: the table is created when the plugin loads, but
 *   creation is not guaranteed to happen before the first query;
 * - always go through `withOrm`: it provides the drizzle instance and logs exceptions uniformly;
 * - row types only travel inside the plugin; past this layer they become the DTOs from
 *   `shared/types.ts` (the renderer does not know drizzle).
 */
function toDto(row: ${vars.pascal}ItemRow): ${vars.pascal}Item {
  return {
    id: row.id,
    title: row.title,
    note: row.note ?? '',
    done: row.done ?? false,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  }
}

/** All records, newest first */
export async function listItems(): Promise<${vars.pascal}Item[]> {
  await schemaReady
  const rows = await withOrm('${vars.id}.listItems', async (db) =>
    db.select().from(${vars.itemsToolName}).orderBy(desc(${vars.itemsToolName}.created_at), desc(${vars.itemsToolName}.id))
  )
  return rows.map(toDto)
}

/** Create a record */
export async function createItem(input: ${vars.pascal}ItemInput): Promise<${vars.pascal}Item> {
  await schemaReady
  const title = String(input?.title ?? '').trim()
  if (!title) throw new Error('标题不能为空')
  const rows = await withOrm('${vars.id}.createItem', async (db) =>
    db
      .insert(${vars.itemsToolName})
      .values({ title, note: String(input?.note ?? '').trim() || null })
      .returning()
  )
  return toDto(rows[0])
}

/** Update a record (only the given fields; returns null when the record does not exist) */
export async function updateItem(
  id: number,
  patch: { title?: string; note?: string; done?: boolean }
): Promise<${vars.pascal}Item | null> {
  await schemaReady
  const next: Partial<${vars.pascal}ItemRow> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) {
    const title = String(patch.title).trim()
    if (!title) throw new Error('标题不能为空')
    next.title = title
  }
  if (patch.note !== undefined) next.note = String(patch.note).trim() || null
  if (patch.done !== undefined) next.done = Boolean(patch.done)
  const rows = await withOrm('${vars.id}.updateItem', async (db) =>
    db.update(${vars.itemsToolName}).set(next).where(eq(${vars.itemsToolName}.id, id)).returning()
  )
  return rows[0] ? toDto(rows[0]) : null
}

/** Delete a record (returns whether it was actually removed) */
export async function deleteItem(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('${vars.id}.deleteItem', async (db) =>
    db.delete(${vars.itemsToolName}).where(eq(${vars.itemsToolName}.id, id)).returning({ id: ${vars.itemsToolName}.id })
  )
  return rows.length > 0
}

/** Delete all records of this plugin (used on uninstall to clear data; returns the row count) */
export async function deleteAllItems(): Promise<number> {
  await schemaReady
  const rows = await withOrm('${vars.id}.deleteAllItems', async (db) =>
    db.delete(${vars.itemsToolName}).returning({ id: ${vars.itemsToolName}.id })
  )
  return rows.length
}
