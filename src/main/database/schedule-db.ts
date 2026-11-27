/**
 * 定时任务的数据库存储实现（系统装配层注入到 `scheduleStore` 门面）。
 *
 * - CRUD / 执行记录都走 `database/mapper/schedule.ts`；
 * - 旧版 `userData/schedules/schedules.json` 在这里做一次性导入（导入成功后改名保留备份）；
 * - 任务数量上限与 id 生成也在这层（业务层不关心存储细节）。
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
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduledTask,
  ScheduledTaskPatch
} from '../runtime/harness/schedule-types'

/** 数据库存储实现 */
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
    }
  ): Promise<ScheduledTask | undefined> {
    return markScheduledTaskRun({
      taskId: id,
      status: result.status,
      ranAt: result.ranAt,
      nextRunAt: result.nextRunAt,
      enabled: result.enabled,
      detail: result.detail ?? null
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
 * 旧版 JSON 任务导入（一次性）。
 *
 * 文件不存在 → skipped；解析失败 → 保留文件不动并返回错误信息（下次启动还会尝试，
 * 用户也可以手工修好 JSON）；导入成功后把文件改名为 `schedules.json.migrated` 保留备份。
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
