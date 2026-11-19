import * as crypto from 'crypto'
import { eq } from 'drizzle-orm'
import { withOrm } from '../../../../../main/database/orm'
import { images } from '../../../../../main/database/schema'

async function saveImage(dataUrl: string | null): Promise<string | null> {
  if (!dataUrl) return null

  return withOrm('saveImage', async (db) => {
    const id = crypto.createHash('md5').update(dataUrl).digest('hex')

    // 同图去重：主键冲突直接忽略（等价于原来的 ON CONFLICT DO NOTHING）
    await db.insert(images).values({ id, data: dataUrl }).onConflictDoNothing()

    return id
  })
}

async function getImageData(id: string): Promise<string | null> {
  return withOrm('getImageData', async (db) => {
    const rows = await db
      .select({ data: images.data })
      .from(images)
      .where(eq(images.id, id))
      .limit(1)
    return rows[0]?.data ?? null
  })
}

export { saveImage, getImageData }
