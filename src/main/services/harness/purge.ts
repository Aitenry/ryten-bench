import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../../context'
import { withOrm } from '../../database/orm'
import { agent_config } from '../../database/schema/harness/agent'
import { file_change } from '../../database/schema/harness/file-change'
import {
  harness_dialogue,
  harness_dialogue_usage,
  harness_goals,
  harness_topic,
  topic_compactions
} from '../../database/schema/harness/harness'
import { closeAllMnemon } from './mnemon-singleton'

/**
 * Implementation of the harness plugin's **self-purge** logic (`plugin.purge` contribution,
 * contract in `src/main/plugins/contributions.ts`).
 *
 * Called by the host when the plugin is uninstalled and the user checked "also delete all of this
 * plugin's data". This is the largest data surface of the four plugins:
 *
 * **① 7 tables in the shared PGlite database** (order: child → parent; `harness_goals` and
 * `topic_compactions` have no foreign keys, so they must be deleted explicitly — see the comments
 * in `db/schema/harness.ts`):
 * `harness_dialogue_usage` → `topic_compactions` → `harness_goals` → `file_change` →
 * `harness_dialogue` → `harness_topic` → `agent_config`.
 *
 * **② App-managed disk directories** (three places, all configured by this plugin in
 * `install`'s `ctx.effect`):
 * - `userData/file-history/`: traceable snapshots of file changes (large bodies live on disk,
 *   only metadata is kept in the database);
 * - `userData/tool-output/`: on-demand details of built-in tool results (`<topicId>/<callId>.json`);
 * - `<memoryPath>/spill/` and `<memoryPath>/workspace-<id>/`: scratch space for model spill-over
 *   plus a full memory set per workspace (mnemon PGlite database, USER/MEMORY, long-term memory
 *   space, sub-agent memory).
 *   **Do not delete** `memoryPath` itself (the user may point it elsewhere and the directory may
 *   contain other things).
 *
 * **Deliberately left untouched**:
 * - the `workspace` table (core's user workspaces / project paths) — that is the user's project,
 *   not the plugin's session data;
 * - the settings key `harness` (holds **configuration** such as API keys, memory directory and
 *   default model) — uninstalling a plugin must not casually delete credentials; everything that
 *   is really "data" lives in the two places above.
 *
 * Call `closeAllMnemon()` before deleting directories: memory stores are **process-level PGlite
 * instances**, and open file handles make deletion incomplete on Windows.
 *
 * Table schemas are never touched: migrations are applied by core, and the migration records must
 * stay consistent after uninstall.
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

  // Memory stores are process-level singletons (cached per workspace); open handles block removal
  await closeAllMnemon()

  const dirs = [
    path.join(app.getPath('userData'), 'file-history'),
    path.join(app.getPath('userData'), 'tool-output')
  ]
  const memoryPath = (settingsStore.get('harness') as { memoryPath?: string } | undefined)
    ?.memoryPath
  if (memoryPath) {
    dirs.push(path.join(memoryPath, 'spill'))
    // Only recognize this plugin's memory scope dirs (workspace `workspace-<number>` + plugin
    // `plugin-<id>`, see memory-scope.ts); leave the rest of memoryPath alone
    try {
      for (const name of fs.readdirSync(memoryPath)) {
        if (/^workspace-\d+$/.test(name) || /^plugin-[A-Za-z0-9._-]+$/.test(name)) {
          dirs.push(path.join(memoryPath, name))
        }
      }
    } catch (err) {
      logger.warn(`[harness] Failed to read memory directory (skipping directory cleanup): ${memoryPath}`, err)
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
      // Directory in use / insufficient permissions: warn only, do not block uninstall (rows are gone)
      logger.warn(`[harness] Failed to clean up managed directory: ${dir}`, err)
    }
  }

  logger.info(
    `[harness] Purged plugin data: sessions ${counts.topics}, conversations ${counts.dialogues}, ` +
      `goals ${counts.goals}, compaction checkpoints ${counts.compactions}, usage ${counts.usage}, ` +
      `subagent configs ${counts.agents}, file change records ${counts.changes}, ` +
      `managed directories ${removedDirs} (table schema, workspace table and harness settings keys untouched)`
  )
}
