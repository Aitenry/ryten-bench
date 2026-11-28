import { useCallback, useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { useTranslation } from '@renderer/i18n'

import type { JobOutputView, JobSnapshot } from '../../../../shared/harness/types'
import { harnessApi } from '../../api/harness'

/**
 * Data source for the top bar's "background jobs" (jobs executed with run_in_background=true).
 *
 * Responsibilities are collected in one place, shared by the top bar button (count) and the
 * inline tray (list / stop / output):
 * - fetch the list by topicId and subscribe to `harness-jobs-updated`;
 * - keep only command jobs (`kind !== 'subagent'`) — background subagents have their own entry;
 * - manual stop goes through `harness-job-kill`; on success the main process broadcasts the list;
 * - peeking at output snapshots does not consume the model's `job_output` cursor.
 *
 * Why a version number: switching topics or opening the tray triggers a manual list fetch, while a
 * broadcast can arrive at any time. A late list snapshot could overwrite a job the broadcast just
 * added, so every broadcast bumps the version, and a fetch result only lands if the version is
 * unchanged.
 */
export interface UseBackgroundJobsResult {
  jobs: JobSnapshot[]
  refresh: () => Promise<void>
  stopJob: (job: JobSnapshot) => Promise<boolean>
  peekOutput: (jobId: string) => Promise<JobOutputView>
}

/** Command jobs (background subagents are not displayed again here) */
const isCommandJob = (job: JobSnapshot): boolean => job.kind !== 'subagent'

export function useBackgroundJobs(currentTopicId: number | null): UseBackgroundJobsResult {
  const api = harnessApi
  const { message } = App.useApp()
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<JobSnapshot[]>([])
  const topicRef = useRef(currentTopicId)
  topicRef.current = currentTopicId
  /** Broadcast/topic-switch version: a late fetch result must not override a newer broadcast */
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
      /* Ignore: a failed list refresh must not disturb the conversation; the job keeps running
       * in the main process */
    }
  }, [api, currentTopicId])

  // Fetch the list + subscribe to change broadcasts (start / stopping / settlement all push)
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
        // The broadcast updates the list; fetch once more here as a fallback for the rare
        // "broadcast lost" case
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
