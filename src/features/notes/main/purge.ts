import { inArray, isNotNull } from 'drizzle-orm'
import logger from 'electron-log'
import { settingsStore } from '../../../main/context'
import { withOrm } from '../../../main/database/orm'
import { images, node_positions } from '../../../main/database/schema/common'
import { documents, documents_content, directory_documents } from './db/schema/document'
import { graph_build_jobs, graph_entities, graph_relations } from './db/schema/graph'
import { task_dependencies, todo_items } from './db/schema/todo'
import { wiki, wiki_directories } from './db/schema/wiki'

/**
 * notes 插件的**自清数据**实现（`plugin.purge` 贡献，契约见 `src/main/plugins/contributions.ts`）。
 *
 * 卸载插件且用户勾了「同时删除该插件的全部数据」时由宿主调用。本插件的用户数据是**用户自己写的东西**
 * （文档、待办、知识库、图谱），所以确认框必须把「会删什么」写清楚——这一条属于插件的
 * `label`/面板文案，实现上这里只负责删干净、且**只删自己的**：
 *
 * 1. `graph_relations` → `graph_entities` → `graph_build_jobs`（挂在知识库下，知识库删了也会级联，
 *    但显式按「子 → 父」删，不依赖运行期外键）；
 * 2. `directory_documents`（目录 ↔ 文档的多对多关联）→ `documents_content`（正文，含配图外键）
 *    → `wiki_directories` → `documents` → `wiki`；
 * 3. `task_dependencies` → `todo_items`（待办与待办依赖）；
 * 4. `node_positions`：图谱画布节点坐标（core 的表，但**只有本插件读写**，见
 *    `main/db/mapper/node-position.ts`）；
 * 5. `images`：core 的图片表，这里只删**确实由本插件插入**的行（文档配图 / 知识库封面
 *    via `image_id`），不碰 music 的封面行；
 * 6. 设置键 `graph`（图谱构建参数）：唯一的编辑器是本插件的图谱设置页，core 在启动时
 *    发现缺失会用默认值补上（`loading-window.ts`），所以删掉等于「回到默认」。
 *
 * 表结构一律不动：迁移由 core 统一应用，卸载后迁移记录必须仍然一致。
 * 不删任何磁盘文件（本插件没有应用托管的目录，图片以 base64 存在 `images.data` 里）。
 */
export async function purgeHomeData(): Promise<void> {
  const counts = await withOrm('purgeHomeData.deleteRows', async (db) =>
    db.transaction(async (tx) => {
      // ① 先取出要清理的图片 id（删行之后就查不到了）
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

      // ② 图谱（挂在知识库下）
      const relations = await tx.delete(graph_relations).returning({ id: graph_relations.id })
      const entities = await tx.delete(graph_entities).returning({ id: graph_entities.id })
      const jobs = await tx.delete(graph_build_jobs).returning({ id: graph_build_jobs.id })

      // ③ 文档 / 目录 / 知识库
      const links = await tx.delete(directory_documents).returning({ id: directory_documents.id })
      const contents = await tx.delete(documents_content).returning({ id: documents_content.id })
      const directories = await tx.delete(wiki_directories).returning({ id: wiki_directories.id })
      const docs = await tx.delete(documents).returning({ id: documents.id })
      const wikis = await tx.delete(wiki).returning({ id: wiki.id })

      // ④ 待办
      const deps = await tx.delete(task_dependencies).returning({ id: task_dependencies.id })
      const todos = await tx.delete(todo_items).returning({ id: todo_items.id })

      // ⑤ 画布坐标 + 仅被本插件引用的图片行
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

  // ⑥ 图谱设置回默认（core 下次启动会补默认值）
  settingsStore.delete('graph')

  logger.info(
    `[notes] 已清除插件数据：文档 ${counts.docs}、正文 ${counts.contents}、知识库 ${counts.wikis}、` +
      `目录 ${counts.directories}、目录关联 ${counts.links}、图谱实体 ${counts.entities}、` +
      `图谱关系 ${counts.relations}、构建任务 ${counts.jobs}、待办 ${counts.todos}、` +
      `待办依赖 ${counts.deps}、画布坐标 ${counts.positions}、图片 ${counts.images}（表结构未动）`
  )
}
