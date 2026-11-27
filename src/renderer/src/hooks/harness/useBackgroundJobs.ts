import { useCallback, useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { useTranslation } from '@renderer/i18n'

import type { JobOutputView, JobSnapshot } from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'

/**
 * 顶部栏「后台任务」的数据源（execute run_in_background=true 的任务）。
 *
 * 职责收在一处，顶部栏按钮（计数）与内联托盘（列表/停止/输出）共用：
 * - 按 topicId 拉列表并订阅 `harness-jobs-updated`；
 * - 只保留命令类任务（`kind !== 'subagent'`）——后台子代理有独立入口；
 * - 手动停止走 `harness-job-kill`，成功后由主进程广播回列表；
 * - peek 输出快照不消费模型的 `job_output` 游标。
 *
 * 为什么需要版本号：切话题/打开托盘时会主动拉一次列表，而广播随时可能先到。
 * 一个晚到的列表快照可能把广播刚加进来的任务覆盖掉，所以每次广播都递增版本，
 * 拉取结果只有在版本没变时才落地。
 */
export interface UseBackgroundJobsResult {
  jobs: JobSnapshot[]
  refresh: () => Promise<void>
  stopJob: (job: JobSnapshot) => Promise<boolean>
  peekOutput: (jobId: string) => Promise<JobOutputView>
}

/** 命令类任务（后台子代理不在这里重复展示） */
const isCommandJob = (job: JobSnapshot): boolean => job.kind !== 'subagent'

export function useBackgroundJobs(currentTopicId: number | null): UseBackgroundJobsResult {
  const api = harnessApi
  const { message } = App.useApp()
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<JobSnapshot[]>([])
  const topicRef = useRef(currentTopicId)
  topicRef.current = currentTopicId
  /** 广播/切话题版本：晚到的 fetch 结果不能覆盖更新的广播 */
  const versionRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (currentTopicId == null) {
      setJobs([])
      return
    }
    const version = versionRef.current
    try {
      const rows = await api.harness.listJobs(currentTopicId)
      if (versionRef.current !== version) return
      if (topicRef.current !== currentTopicId) return
      setJobs((rows ?? []).filter(isCommandJob))
    } catch {
      /* 忽略：列表刷新失败不打扰对话，后台任务本身仍在主进程里跑 */
    }
  }, [api, currentTopicId])

  // 拉列表 + 订阅变更广播（开始 / 停止中 / 结算都会推）
  useEffect(() => {
    versionRef.current += 1
    setJobs([])
    void refresh()
    const unsubscribe = api.harness.onJobsUpdated((data) => {
      if (data.topicId !== currentTopicId) return
      versionRef.current += 1
      setJobs((data.jobs ?? []).filter(isCommandJob))
    })
    return () => {
      unsubscribe()
    }
  }, [api, currentTopicId, refresh])

  const stopJob = useCallback(
    async (job: JobSnapshot): Promise<boolean> => {
      if (currentTopicId == null) return false
      try {
        const result = await api.harness.killJob(currentTopicId, job.id)
        if (result.outcome === 'not-found') {
          message.warning(t('harness.backgroundJobs.alreadyFinished'))
          return false
        }
        return true
      } catch (error) {
        message.error(
          t('harness.backgroundJobs.stopFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
        return false
      } finally {
        // 广播会更新列表；这里再拉一次，兜底「广播丢了」的极端情况
        void refresh()
      }
    },
    [api, currentTopicId, message, refresh, t]
  )

  const peekOutput = useCallback(
    (jobId: string): Promise<JobOutputView> => {
      if (currentTopicId == null) {
        return Promise.resolve({ text: '', truncated: false })
      }
      return api.harness.peekJobOutput(currentTopicId, jobId)
    },
    [api, currentTopicId]
  )

  return { jobs, refresh, stopJob, peekOutput }
}
