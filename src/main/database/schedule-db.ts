/**
 * Database-backed storage for scheduled tasks (wired into the `scheduleStore` facade by the system
 * assembly layer).
 *
 * - CRUD and run records both go through `database/mapper/schedule.ts`;
 * - Legacy `userData/schedules/schedules.json` is imported here once (renamed afterwards to keep a
 *   backup);
 * - The task count limit and id generation also live in this layer (the business layer does not
 *   care about storage details).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import logger from 'electron-log'
import {
  countScheduledTaskRuns,
  countScheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  importScheduledTasks,
  listScheduledTaskRuns,
  listScheduledTasks,
  markScheduledTaskRun,
  updateScheduledTask
} from './mapper/schedule'
import {
  MAX_SCHEDULED_TASKS,
  createTaskId,
  type ScheduleStore
} from '../runtime/harness/schedule-store'
import { parseLegacySchedules } from '../runtime/harness/schedule-legacy'
import type {
  ScheduleCreateInput,
  ScheduleRunArtifact,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleRunStep,
  ScheduleRunUsage,
  ScheduledTask,
  ScheduledTaskPatch
} from '../runtime/harness/schedule-types'

/** Database-backed store implementation */
export class DbScheduleStore implements ScheduleStore {
  async list(): Promise<ScheduledTask[]> {
    return listScheduledTasks()
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    return getScheduledTask(id)
  }

  async create(input: ScheduleCreateInput): Promise<ScheduledTask> {
    const count = await countScheduledTasks()
    if (count >= MAX_SCHEDULED_TASKS) {
      throw new Error(`too many scheduled tasks (limit ${MAX_SCHEDULED_TASKS})`)
    }
    return createScheduledTask({ ...input, id: createTaskId() })
  }

  async update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask | undefined> {
    return updateScheduledTask(id, patch)
  }

  async remove(id: string): Promise<boolean> {
    return deleteScheduledTask(id)
  }

  async markRun(
    id: string,
    result: {
      status: ScheduleRunStatus
      ranAt: string
      nextRunAt: string | null
      enabled?: boolean
      detail?: string | null
      topicId?: number | null
      dialogueId?: number | null
      usage?: ScheduleRunUsage | null
      steps?: ScheduleRunStep[] | null
      artifacts?: ScheduleRunArtifact[] | null
    }
  ): Promise<ScheduledTask | undefined> {
    return markScheduledTaskRun({
      taskId: id,
      status: result.status,
      ranAt: result.ranAt,
      nextRunAt: result.nextRunAt,
      enabled: result.enabled,
      detail: result.detail ?? null,
      topicId: result.topicId ?? null,
      dialogueId: result.dialogueId ?? null,
      usage: result.usage ?? null,
      steps: result.steps ?? null,
      artifacts: result.artifacts ?? null
    })
  }

  async listRuns(taskId: string, limit?: number, offset?: number): Promise<ScheduleRunRecord[]> {
    return listScheduledTaskRuns(taskId, limit, offset)
  }

  async countRuns(taskId: string): Promise<number> {
    return countScheduledTaskRuns(taskId)
  }
}

/**
 * One-time import of legacy JSON tasks.
 *
 * File missing → skipped; parse failure → leave the file untouched and return the error (it is
 * retried on the next start, and the user can also fix the JSON by hand); after a successful import
 * the file is renamed to `schedules.json.migrated` to keep a backup.
 */
export async function migrateLegacySchedules(dir: string): Promise<{
  imported: number
  skipped: boolean
  error?: string
}> {
  const file = path.join(dir, 'schedules.json')
  if (!fs.existsSync(file)) return { imported: 0, skipped: true }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[Schedule] Legacy schedules file is not valid JSON, kept for manual fix: ${message}`)
    return { imported: 0, skipped: false, error: message }
  }

  const tasks = parseLegacySchedules(raw)
  let imported = 0
  try {
    imported = await importScheduledTasks(
      tasks.map((task) => ({
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        when: task.when,
        enabled: task.enabled,
        topicId: task.topicId,
        workspaceId: null,
        nextRunAt: task.nextRunAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        lastRunAt: task.lastRunAt,
        lastStatus: task.lastStatus
      }))
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[Schedule] Legacy schedules import failed, will retry next start: ${message}`)
    return { imported: 0, skipped: false, error: message }
  }

  try {
    fs.renameSync(file, `${file}.migrated`)
  } catch (err) {
    logger.warn('[Schedule] Imported legacy schedules but could not rename the old file:', err)
  }
  logger.info(
    `[Schedule] Imported ${imported} legacy scheduled task(s) from ${file} (parsed ${tasks.length})`
  )
  return { imported, skipped: false }
}
