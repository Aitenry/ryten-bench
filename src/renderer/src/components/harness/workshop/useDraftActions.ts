import { useCallback, useRef, useState } from 'react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import type { WorkshopPublishResult } from '../../../../../shared/harness/workshop'
import { harnessApi } from '../../../api/harness'

/**
 * 草稿行上的动作（构建 / 验收 / 安装）。
 *
 * 为什么抽成 hook：侧栏「插件」模式的行与设置 → 插件工坊的行都要这三个动作，
 * 两处各写一份的话，忙碌态、失败原文、成功提示的口径迟早会分叉（这个仓库里
 * 「同一功能两个入口两套行为」的教训已经有过）。
 *
 * 约定与设置页一致：
 * - **忙碌态按草稿 id 记**（`busyIds` 集合）：不同草稿可以各跑各的，同一草稿重复点击
 *   直接忽略（以前是单个 `busyId`，点 A 再点 B 会把 A 的忙碌态覆盖掉，A 还在构建时
 *   行的删除/再次构建按钮就重新可点了）；
 * - 失败**显示主进程原话**（构建诊断/验收失败项是给用户看的，不要吞掉）；
 * - 动作成功后回调 `onChanged`（调用方各自刷新列表 / 重开抽屉）。
 */
export function useDraftActions(opts: {
  /** 动作成功后的刷新（列表重拉、抽屉重开等） */
  onChanged: (id: string) => void | Promise<void>
}): {
  busyIds: ReadonlySet<string>
  run: <T>(
    id: string,
    action: () => Promise<{ ok: boolean; error?: string; data?: T }>,
    onSuccess?: (data: T | undefined) => void
  ) => Promise<boolean>
  build: (id: string) => Promise<boolean>
  verify: (id: string) => Promise<boolean>
  publish: (
    id: string,
    onSuccess?: (data: WorkshopPublishResult | undefined) => void
  ) => Promise<boolean>
} {
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const { onChanged } = opts
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  /** 最新忙碌集合（回调里判断重复点击，不依赖渲染闭包） */
  const busyIdsRef = useRef<ReadonlySet<string>>(busyIds)
  busyIdsRef.current = busyIds

  /**
   * 统一执行一次工坊动作：置忙 → 调主进程 → 失败提示原文 → 成功后刷新。
   *
   * `onSuccess` 拿到的是动作的真实返回值（构建诊断 / 验收报告），用于给更强的反馈
   * （例如验收未通过时把失败项数报出来）——刻意**不重复调用**接口：
   * 构建/验收都是重活，调两次等于干两遍。
   */
  const run = useCallback(
    async <T>(
      id: string,
      action: () => Promise<{ ok: boolean; error?: string; data?: T }>,
      onSuccess?: (data: T | undefined) => void
    ): Promise<boolean> => {
      if (busyIdsRef.current.has(id)) return false
      setBusyIds((previous) => new Set(previous).add(id))
      try {
        const result = await action()
        if (!result.ok) {
          viewMessage(
            `workshop-${id}`,
            'error',
            result.error ?? t('workshopSettings.actionFailed'),
            6
          )
          return false
        }
        onSuccess?.(result.data)
        await onChanged(id)
        return true
      } catch (error) {
        viewMessage(`workshop-${id}`, 'error', String(error))
        return false
      } finally {
        setBusyIds((previous) => {
          const next = new Set(previous)
          next.delete(id)
          return next
        })
      }
    },
    [onChanged, t, viewMessage]
  )

  const build = useCallback(
    (id: string): Promise<boolean> =>
      run(
        id,
        () => harnessApi.workshop.build(id),
        (info) => {
          if (info && !info.ok) {
            viewMessage(`workshop-build-${id}`, 'error', info.errors.join('；'), 6)
          } else if (info) {
            viewMessage(
              `workshop-build-${id}`,
              'success',
              t('workshopSettings.build.ok', { count: info.files.length }),
              3
            )
          }
        }
      ),
    [run, t, viewMessage]
  )

  const verify = useCallback(
    (id: string): Promise<boolean> =>
      run(
        id,
        () => harnessApi.workshop.verify(id, true),
        (report) => {
          if (!report) return
          const failed = report.checks.filter((c) => c.status === 'fail').length
          viewMessage(
            `workshop-verify-${id}`,
            report.ok ? 'success' : 'error',
            report.ok
              ? t('workshopSettings.verify.passed', { count: report.checks.length })
              : t('workshopSettings.verify.failed', { count: failed }),
            4
          )
        }
      ),
    [run, t, viewMessage]
  )

  const publish = useCallback(
    (id: string, onSuccess?: (data: WorkshopPublishResult | undefined) => void): Promise<boolean> =>
      run(id, () => harnessApi.workshop.publish(id), onSuccess),
    [run]
  )

  return { busyIds, run, build, verify, publish }
}
