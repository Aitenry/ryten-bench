import { useCallback, useState } from 'react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import type { WorkshopPublishResult } from '../../../shared/workshop'
import { harnessApi } from '../../api'

/**
 * 草稿行上的动作（构建 / 验收 / 安装）。
 *
 * 为什么抽成 hook：侧栏「插件」模式的行与设置 → 插件工坊的行都要这三个动作，
 * 两处各写一份的话，忙碌态、失败原文、成功提示的口径迟早会分叉（这个仓库里
 * 「同一功能两个入口两套行为」的教训已经有过）。
 *
 * 约定与设置页一致：
 * - **忙碌态按草稿 id 记**（`busyId`），一次只跑一个重活；
 * - 失败**显示主进程原话**（构建诊断/验收失败项是给用户看的，不要吞掉）；
 * - 动作成功后回调 `onChanged`（调用方各自刷新列表 / 重开抽屉）。
 */
export function useDraftActions(opts: {
  /** 动作成功后的刷新（列表重拉、抽屉重开等） */
  onChanged: (id: string) => void | Promise<void>
}): {
  busyId: string
  run: <T>(
    id: string,
    action: () => Promise<{ ok: boolean; error?: string; data?: T }>,
    onSuccess?: (data: T | undefined) => void
  ) => Promise<void>
  build: (id: string) => Promise<void>
  verify: (id: string) => Promise<void>
  publish: (
    id: string,
    onSuccess?: (data: WorkshopPublishResult | undefined) => void
  ) => Promise<void>
} {
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const { onChanged } = opts
  const [busyId, setBusyId] = useState('')

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
    ): Promise<void> => {
      setBusyId(id)
      try {
        const result = await action()
        if (!result.ok) {
          viewMessage(
            `workshop-${id}`,
            'error',
            result.error ?? t('workshopSettings.actionFailed'),
            6
          )
          return
        }
        onSuccess?.(result.data)
        await onChanged(id)
      } catch (error) {
        viewMessage(`workshop-${id}`, 'error', String(error))
      } finally {
        setBusyId('')
      }
    },
    [onChanged, t, viewMessage]
  )

  const build = useCallback(
    (id: string): Promise<void> =>
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
    (id: string): Promise<void> =>
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
    (id: string, onSuccess?: (data: WorkshopPublishResult | undefined) => void): Promise<void> =>
      run(id, () => harnessApi.workshop.publish(id), onSuccess),
    [run]
  )

  return { busyId, run, build, verify, publish }
}
