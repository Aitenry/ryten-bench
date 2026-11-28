import { inArray, isNotNull } from 'drizzle-orm'
import logger from 'electron-log'
import { settingsStore } from '../../context'
import { withOrm } from '../../database/orm'
import { images, node_positions } from '../../database/schema/common'
import {
  documents,
  documents_content,
  directory_documents
} from '../../database/schema/notes/document'
import {
  graph_build_jobs,
  graph_entities,
  graph_relations
} from '../../database/schema/notes/graph'
import { task_dependencies, todo_items } from '../../database/schema/notes/todo'
import { wiki, wiki_directories } from '../../database/schema/notes/wiki'

/**
 * **Self-purge data** implementation for the notes plugin (contributed via `plugin.purge`, contract in
 * `src/main/plugins/contributions.ts`).
 *
 * Called by the host when the plugin is uninstalled and the user checked "also delete all data for this
 * plugin". This plugin's user data is **what the user wrote themselves** (documents, todos, knowledge bases,
 * graphs), so the confirmation dialog must spell out what will be deleted — that belongs to the plugin's
 * `label`/panel copy; this implementation is only responsible for deleting thoroughly and **only its own data**:
 *
 * 1. `graph_relations` → `graph_entities` → `graph_build_jobs` (they hang off the knowledge base and would
 *    cascade when it is deleted, but we delete explicitly from child → parent, without relying on runtime
 *    foreign keys);
 * 2. `directory_documents` (many-to-many directory ↔ document links) → `documents_content` (body, including the
 *    image foreign key) → `wiki_directories` → `documents` → `wiki`;
 * 3. `task_dependencies` → `todo_items` (todos and todo dependencies);
 * 4. `node_positions`: graph canvas node coordinates (a core table, but **only this plugin reads/writes it**,
 *    see `main/db/mapper/node-position.ts`);
 * 5. `images`: the core image table; here only rows **actually inserted by this plugin** are deleted (document
 *    images / knowledge base covers via `image_id`), music cover rows are untouched;
 * 6. Settings key `graph` (graph build parameters): the only editor is this plugin's graph settings page, and
 *    core fills in defaults at startup when it finds it missing (`loading-window.ts`), so deleting it means
 *    "back to defaults".
 *
 * Table schemas are never touched: migrations are applied centrally by core, and migration records must remain
 * consistent after uninstall. No disk files are deleted (this plugin has no app-managed directory; images live
 * as base64 in `images.data`).
 */
export async function purgeHomeData(): Promise<void> {
  const counts = await withOrm('purgeHomeData.deleteRows', async (db) =>
    db.transaction(async (tx) => {
      // ① Collect the image ids to clean up first (they cannot be queried once the rows are deleted)
      const imageIds = new Set<string>()
      const docImages = await tx
        .select({ image_id: documents_content.image_id })
        .from(documents_content)
        .where(isNotNull(documents_content.image_id))
      for (const row of docImages) if (row.image_id) imageIds.add(row.image_id)
      const wikiImages = await tx
        .select({ image_id: wiki.image_id })
        .from(wiki)
        .where(isNotNull(wiki.image_id))
      for (const row of wikiImages) if (row.image_id) imageIds.add(row.image_id)

      // ② Graph (hangs off the knowledge base)
      const relations = await tx.delete(graph_relations).returning({ id: graph_relations.id })
      const entities = await tx.delete(graph_entities).returning({ id: graph_entities.id })
      const jobs = await tx.delete(graph_build_jobs).returning({ id: graph_build_jobs.id })

      // ③ Documents / directories / knowledge bases
      const links = await tx.delete(directory_documents).returning({ id: directory_documents.id })
      const contents = await tx.delete(documents_content).returning({ id: documents_content.id })
      const directories = await tx.delete(wiki_directories).returning({ id: wiki_directories.id })
      const docs = await tx.delete(documents).returning({ id: documents.id })
      const wikis = await tx.delete(wiki).returning({ id: wiki.id })

      // ④ Todos
      const deps = await tx.delete(task_dependencies).returning({ id: task_dependencies.id })
      const todos = await tx.delete(todo_items).returning({ id: todo_items.id })

      // ⑤ Canvas positions + image rows referenced only by this plugin
      const positions = await tx
        .delete(node_positions)
        .returning({ node_id: node_positions.node_id })
      const removedImages =
        imageIds.size > 0
          ? await tx
              .delete(images)
              .where(inArray(images.id, [...imageIds]))
              .returning({ id: images.id })
          : []

      return {
        relations: relations.length,
        entities: entities.length,
        jobs: jobs.length,
        links: links.length,
        contents: contents.length,
        directories: directories.length,
        docs: docs.length,
        wikis: wikis.length,
        deps: deps.length,
        todos: todos.length,
        positions: positions.length,
        images: removedImages.length
      }
    })
  )

  // ⑥ Reset graph settings to defaults (core fills in defaults on its next startup)
  settingsStore.delete('graph')

  logger.info(
    `[notes] Purged plugin data: docs ${counts.docs}, contents ${counts.contents}, wikis ${counts.wikis}, ` +
      `directories ${counts.directories}, directory links ${counts.links}, graph entities ${counts.entities}, ` +
      `graph relations ${counts.relations}, build jobs ${counts.jobs}, todos ${counts.todos}, ` +
      `todo dependencies ${counts.deps}, canvas positions ${counts.positions}, images ${counts.images} (table schema untouched)`
  )
}
