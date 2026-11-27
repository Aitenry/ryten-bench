/**
 * 定时任务存储层回归（esbuild 打包，node:test）：
 * - 旧 JSON 解析与导入计划（纯逻辑）；
 * - `scheduleStore` 门面的后端注入/委托/未装配行为。
 *
 * 由 `scripts/ai-selftest.mjs` 打包执行（cjs 格式，因此**不使用顶层 await**）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  configureScheduleStoreBackend,
  isScheduleStoreConfigured,
  scheduleStore,
  type ScheduleStore
} from '../../src/main/runtime/harness/schedule-store'
import { parseLegacySchedules } from '../../src/main/runtime/harness/schedule-legacy'
import type { ScheduledTask } from '../../src/main/runtime/harness/schedule-types'

const now = new Date('2026-11-27T10:00:00Z')

test('schedule legacy: parse and normalise old JSON tasks', () => {
  const legacyTasks = parseLegacySchedules(
    [
      {
        id: 'sched-old-1',
        title: '日报',
        prompt: '写日报',
        when: { kind: 'daily', time: '09:00' },
        enabled: true,
        topicId: 3,
        nextRunAt: '2026-11-27T01:00:00.000Z',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z'
      },
      // 一次性任务已过期：导入为暂停，不立即触发
      {
        id: 'sched-old-2',
        title: '一次性',
        prompt: '跑一次',
        when: { kind: 'once', at: '2026-11-01T00:00:00.000Z' },
        enabled: true,
        topicId: 4
      },
      // 非法规则 / 缺 prompt / 缺 topicId 都被跳过；重复 id 去重
      { id: 'bad-when', prompt: 'x', when: { kind: 'weekly' }, topicId: 3 },
      { id: 'no-prompt', when: { kind: 'every', minutes: 10 }, topicId: 3 },
      { id: 'no-topic', prompt: 'x', when: { kind: 'every', minutes: 10 } },
      { id: 'dup', prompt: 'x', when: { kind: 'every', minutes: 10 }, topicId: 3 },
      { id: 'dup', prompt: 'y', when: { kind: 'every', minutes: 10 }, topicId: 3 }
    ],
    now
  )

  assert.equal(legacyTasks.length, 3)
  assert.deepEqual(
    legacyTasks.map((task) => task.id),
    ['sched-old-1', 'sched-old-2', 'dup']
  )
  assert.equal(legacyTasks[0].enabled, true)
  assert.ok(legacyTasks[0].nextRunAt)
  if (legacyTasks[0].nextRunAt) {
    assert.ok(new Date(legacyTasks[0].nextRunAt).getTime() > now.getTime())
  }
  assert.equal(legacyTasks[1].enabled, false)
  assert.equal(legacyTasks[1].nextRunAt, null)
  assert.deepEqual(parseLegacySchedules(null), [])
  assert.deepEqual(parseLegacySchedules({}), [])
})

test('schedule store facade: delegates to the configured backend', async () => {
  // 未装配：调用必须抛错（工具层据此提示「暂不可用」）
  configureScheduleStoreBackend(undefined)
  assert.equal(isScheduleStoreConfigured(), false)
  await assert.rejects(() => scheduleStore.list(), /not configured/)

  const calls: string[] = []
  const task: ScheduledTask = {
    id: 'sched-1',
    title: 'T',
    prompt: 'P',
    when: { kind: 'every', minutes: 10 },
    enabled: true,
    topicId: 1,
    workspaceId: null,
    targetMode: 'work',
    targetWorkspaceId: null,
    targetMemoryScope: null,
    agentConfig: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: new Date(now.getTime() + 600_000).toISOString()
  }
  const fake: ScheduleStore = {
    list: async () => {
      calls.push('list')
      return [task]
    },
    get: async (id) => {
      calls.push(`get:${id}`)
      return id === task.id ? task : undefined
    },
    create: async (input) => {
      calls.push(`create:${input.title}`)
      return { ...task, title: input.title }
    },
    update: async (id, patch) => {
      calls.push(`update:${id}`)
      return { ...task, ...patch }
    },
    remove: async (id) => {
      calls.push(`remove:${id}`)
      return id === task.id
    },
    markRun: async (_id, result) => {
      calls.push(`markRun:${result.status}`)
      return { ...task, lastStatus: result.status }
    },
    listRuns: async (id, limit) => {
      calls.push(`listRuns:${id}:${limit ?? ''}`)
      return [{ at: now.toISOString(), status: 'completed' }]
    },
    countRuns: async (id) => {
      calls.push(`countRuns:${id}`)
      return 1
    }
  }
  configureScheduleStoreBackend(fake)
  assert.equal(isScheduleStoreConfigured(), true)
  assert.equal((await scheduleStore.list()).length, 1)
  assert.equal(await scheduleStore.get('missing'), undefined)
  assert.equal(
    (
      await scheduleStore.create({
        title: 'created',
        prompt: task.prompt,
        when: task.when,
        topicId: task.topicId,
        workspaceId: null,
        nextRunAt: task.nextRunAt ?? new Date().toISOString()
      })
    ).title,
    'created'
  )
  assert.equal((await scheduleStore.update('sched-1', { enabled: false }))?.enabled, false)
  assert.equal(await scheduleStore.remove('sched-1'), true)
  assert.equal(
    (
      await scheduleStore.markRun('sched-1', {
        status: 'completed',
        ranAt: now.toISOString(),
        nextRunAt: null
      })
    )?.lastStatus,
    'completed'
  )
  assert.equal((await scheduleStore.listRuns('sched-1', 5)).length, 1)
  assert.equal(await scheduleStore.countRuns('sched-1'), 1)
  assert.deepEqual(calls, [
    'list',
    'get:missing',
    'create:created',
    'update:sched-1',
    'remove:sched-1',
    'markRun:completed',
    'listRuns:sched-1:5',
    'countRuns:sched-1'
  ])

  configureScheduleStoreBackend(undefined)
  assert.equal(isScheduleStoreConfigured(), false)
})
