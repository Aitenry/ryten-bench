import * as crypto from 'crypto'
import { eq } from 'drizzle-orm'
import { withOrm } from '../../orm'
import { images } from '../../schema'

async function saveImage(dataUrl: string | null): Promise<string | null> {
  if (!dataUrl) return null

  return withOrm('saveImage', async (db) => {
    const id = crypto.createHash('md5').update(dataUrl).digest('hex')

    // Deduplicate identical images: ignore primary-key conflicts (equivalent to the original
    // ON CONFLICT DO NOTHING)
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
