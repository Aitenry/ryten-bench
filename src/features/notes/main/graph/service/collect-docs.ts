import { getDocById } from '../../db/mapper/document'
import { getDirectoriesByWikiId, getDocsByDirectoryId } from '../../db/mapper/wiki'
import { assembleDocContent } from '../utils'

export async function collectWikiDocs(
  wikiId: number
): Promise<{ docId: number; content: string; title: string }[]> {
  const directories = await getDirectoriesByWikiId(wikiId)
  const seenDocIds = new Set<number>()

  const docRefs: { doc_id: number }[] = []
  for (const dir of directories) {
    const refs = await getDocsByDirectoryId(dir.id)
    for (const ref of refs) {
      if (!seenDocIds.has(ref.doc_id)) {
        seenDocIds.add(ref.doc_id)
        docRefs.push({ doc_id: ref.doc_id })
      }
    }
  }

  const BATCH_SIZE = 20
  const results: { docId: number; content: string; title: string }[] = []

  for (let i = 0; i < docRefs.length; i += BATCH_SIZE) {
    const batch = docRefs.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (ref) => {
        const note = await getDocById(ref.doc_id)
        if (note && note.content) {
          return {
            docId: note.id,
            content: assembleDocContent(note.title, note.content),
            title: note.title
          }
        }
        return null
      })
    )
    for (const result of batchResults) {
      if (result) results.push(result)
    }
  }

  return results
}
