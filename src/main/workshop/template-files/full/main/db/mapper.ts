import { desc, eq } from 'drizzle-orm'
import { withOrm } from '@host/main/database/orm'
import type { ${vars.pascal}Item, ${vars.pascal}ItemInput } from '../../shared/harness/types'
import { schemaReady } from './ddl'
import { ${vars.itemsToolName}, type ${vars.pascal}ItemRow } from './schema'

/**
 * ${vars.title} 的数据访问层。
 *
 * 规矩（与宿主 mapper 一致）：
 * - **每个函数先 `await schemaReady`**：插件装载即建表，但不保证建表先于第一次查询；
 * - 一律走 `withOrm`：拿到 drizzle 实例、异常统一记日志；
 * - 行类型只在插件内部流转，出这一层就转成 `shared/types.ts` 的 DTO（渲染层不认识 drizzle）。
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

/** 全部记录（新的在前） */
export async function listItems(): Promise<${vars.pascal}Item[]> {
  await schemaReady
  const rows = await withOrm('${vars.id}.listItems', async (db) =>
    db.select().from(${vars.itemsToolName}).orderBy(desc(${vars.itemsToolName}.created_at), desc(${vars.itemsToolName}.id))
  )
  return rows.map(toDto)
}

/** 新建一条 */
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

/** 改一条（只改传进来的字段；返回 null = 这条不存在） */
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

/** 删一条（返回是否真的删掉了） */
export async function deleteItem(id: number): Promise<boolean> {
  await schemaReady
  const rows = await withOrm('${vars.id}.deleteItem', async (db) =>
    db.delete(${vars.itemsToolName}).where(eq(${vars.itemsToolName}.id, id)).returning({ id: ${vars.itemsToolName}.id })
  )
  return rows.length > 0
}

/** 删掉本插件的全部记录（卸载清数据用；返回删了几行） */
export async function deleteAllItems(): Promise<number> {
  await schemaReady
  const rows = await withOrm('${vars.id}.deleteAllItems', async (db) =>
    db.delete(${vars.itemsToolName}).returning({ id: ${vars.itemsToolName}.id })
  )
  return rows.length
}
