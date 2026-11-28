import { useCallback, useRef, useState } from 'react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import type { WorkshopPublishResult } from '../../../../../shared/harness/workshop'
import { harnessApi } from '../../../api/harness'

/**
 * Actions on a draft row (build / verify / install).
 *
 * Why a hook: both the sidebar "plugins" mode rows and the Settings → Plugin Workshop rows need
 * these three actions; writing them twice would sooner or later let the busy state, raw failure
 * text and success toasts drift apart (this repo has already had its lesson about "one feature,
 * two entries, two behaviors").
 *
 * Conventions match the settings page:
 * - **busy state is tracked per draft id** (the `busyIds` set): different drafts can run
 *   independently, and repeated clicks on the same draft are ignored (it used to be a single
 *   `busyId`, so clicking A then B overwrote A's busy state and while A was still building the
 *   row's delete / rebuild buttons became clickable again);
 * - failures **show the main process's exact wording** (build diagnostics / verification failures
 *   are meant for the user; don't swallow them);
 * - after a successful action call `onChanged` (each caller refreshes its own list / reopens the
 *   drawer).
 */
export function useDraftActions(opts: {
  /** Refresh after a successful action (re-fetch the list, reopen the drawer, etc.) */
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
  /** Latest busy set (used in callbacks to detect duplicate clicks without relying on the render closure) */
  const busyIdsRef = useRef<ReadonlySet<string>>(busyIds)
  busyIdsRef.current = busyIds

  /**
   * Run one workshop action uniformly: mark busy → call the main process → show the raw failure
   * text → refresh on success.
   *
   * `onSuccess` receives the action's real return value (build diagnostics / verification report)
   * to allow stronger feedback (e.g. reporting the number of failed checks when verification
   * fails) — deliberately **without calling** the API again: build / verify are heavy, calling
   * twice means doing the work twice.
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
