import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../../../main/context'
import { withOrm } from '../../../main/database/orm'
import { agent_config } from './db/schema/agent'
import { file_change } from './db/schema/file-change'
import {
  harness_dialogue,
  harness_dialogue_usage,
  harness_goals,
  harness_topic,
  topic_compactions
} from './db/schema/harness'
import { closeAllMnemon } from './mnemon-singleton'

/**
 * harness 插件的**自清数据**实现（`plugin.purge` 贡献，契约见 `src/main/plugins/contributions.ts`）。
 *
 * 卸载插件且用户勾了「同时删除该插件的全部数据」时由宿主调用。这是四个插件里数据面最大的一块：
 *
 * **① 共享 PGlite 里的 7 张表**（顺序：子 → 父；`harness_goals` / `topic_compactions` 没有外键，
 * 只能显式删——见 `db/schema/harness.ts` 的注释）：
 * `harness_dialogue_usage` → `topic_compactions` → `harness_goals` → `file_change` →
 * `harness_dialogue` → `harness_topic` → `agent_config`。
 *
 * **② 应用托管的磁盘目录**（三处，全部由本插件在 `install` 的 `ctx.effect` 里配置）：
 * - `userData/file-history/`：文件改动的可回溯快照（大块正文放磁盘，库里只存元信息）；
 * - `userData/tool-output/`：内置工具结果的按需详情（`<topicId>/<callId>.json`）；
 * - `<memoryPath>/spill/` 与 `<memoryPath>/workspace-<id>/`：模型临时落盘区 + 每个工作区
 *   一整套记忆（mnemon PGlite 库、USER/MEMORY、长期记忆空间、子代理记忆）。
 *   **不删** `memoryPath` 本身（用户可能把它指向别处、目录里还有别的东西）。
 *
 * **刻意不动的东西**：
 * - `workspace` 表（core 的用户工作区/项目路径）——那是用户的工程，不是插件的会话数据；
 * - 设置键 `harness`（里面是 API Key、记忆目录、默认模型这类**配置**）——卸载插件不该
 *   顺手把凭据删掉；真正属于「数据」的东西都在上面两处。
 *
 * 删目录前必须先 `closeAllMnemon()`：记忆库是**进程级 PGlite 实例**，开着文件句柄时
 * 在 Windows 上删不干净。
 *
 * 表结构一律不动：迁移由 core 统一应用，卸载后迁移记录必须仍然一致。
 */
export async function purgeHarnessData(): Promise<void> {
  const counts = await withOrm('purgeHarnessData.deleteRows', async (db) =>
    db.transaction(async (tx) => {
      const usage = await tx
        .delete(harness_dialogue_usage)
        .returning({ id: harness_dialogue_usage.id })
      const compactions = await tx
        .delete(topic_compactions)
        .returning({ topic_id: topic_compactions.topic_id })
      const goals = await tx.delete(harness_goals).returning({ topic_id: harness_goals.topic_id })
      const changes = await tx.delete(file_change).returning({ id: file_change.id })
      const dialogues = await tx.delete(harness_dialogue).returning({ id: harness_dialogue.id })
      const topics = await tx.delete(harness_topic).returning({ id: harness_topic.id })
      const agents = await tx.delete(agent_config).returning({ id: agent_config.id })
      return {
        usage: usage.length,
        compactions: compactions.length,
        goals: goals.length,
        changes: changes.length,
        dialogues: dialogues.length,
        topics: topics.length,
        agents: agents.length
      }
    })
  )

  // 记忆库是进程级单例（按工作区缓存），开着句柄会删不掉目录
  await closeAllMnemon()

  const dirs = [
    path.join(app.getPath('userData'), 'file-history'),
    path.join(app.getPath('userData'), 'tool-output')
  ]
  const memoryPath = (settingsStore.get('harness') as { memoryPath?: string } | undefined)
    ?.memoryPath
  if (memoryPath) {
    dirs.push(path.join(memoryPath, 'spill'))
    // 只认本插件建的记忆作用域目录（工作区 `workspace-<数字>` + 插件 `plugin-<id>`，
    // 见 memory-scope.ts），不碰 memoryPath 下的其它内容
    try {
      for (const name of fs.readdirSync(memoryPath)) {
        if (/^workspace-\d+$/.test(name) || /^plugin-[A-Za-z0-9._-]+$/.test(name)) {
          dirs.push(path.join(memoryPath, name))
        }
      }
    } catch (err) {
      logger.warn(`[harness] 读取记忆目录失败（跳过目录清理）: ${memoryPath}`, err)
    }
  }

  let removedDirs = 0
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removedDirs += 1
      }
    } catch (err) {
      // 目录被占用/权限不足：只告警，不阻塞卸载（行已经删干净了）
      logger.warn(`[harness] 清理托管目录失败: ${dir}`, err)
    }
  }

  logger.info(
    `[harness] 已清除插件数据：会话 ${counts.topics}、对话 ${counts.dialogues}、` +
      `目标 ${counts.goals}、压缩检查点 ${counts.compactions}、用量 ${counts.usage}、` +
      `子代理配置 ${counts.agents}、文件改动记录 ${counts.changes}、托管目录 ${removedDirs} 个` +
      `（表结构、工作区表与 harness 设置键未动）`
  )
}
