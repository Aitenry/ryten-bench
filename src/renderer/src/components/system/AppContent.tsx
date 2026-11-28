// AppContent.tsx
import React, { useEffect, useCallback } from 'react'
import AppShell from '@renderer/components/system/shell/AppShell'
import LockScreen from '@renderer/components/system/LockScreen'
import { MessageProvider } from '@renderer/providers/MessageProvider'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import {
  installLockScreenBridge,
  requestLock,
  requestUnlock,
  useLockScreenState
} from './lock-screen-state'
import type { LockUnlockResult } from '@renderer/types/settings'

/**
 * Application content layer: shell + lock screen.
 *
 * Lock screen state is no longer held by a `useState` here (the old implementation
 * unlocked on page refresh): `locked` comes from the main-process snapshot
 * (`lock-screen-state.ts`), and verification/backoff/auto-lock also live in the main
 * process (`src/main/lock/service.ts`). This component only does two things:
 * - request the lock on Esc;
 * - hand the unlock code to the main process for verification and return the failure
 *   result to the lock screen for display.
 */
const AppContent: React.FC = () => {
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const { enabled, hasCode, locked } = useLockScreenState()

  /**
   * Attach the main-process lock-screen push + initial fetch. Under StrictMode this mounts
   * twice; the bridge keeps a single IPC listener by reference counting, so events are not
   * handled twice.
   */
  useEffect(() => installLockScreenBridge(), [])

  // Manual lock on Esc: the main process refuses to lock when disabled / no unlock code is set
  // (better for Esc to do nothing than to lock into a screen you cannot get past)
  const handleLockScreen = useCallback((): void => {
    if (!enabled || !hasCode) return
    void requestLock().catch((error) => {
      console.error('[lock-screen] Failed to request lock:', error)
    })
  }, [enabled, hasCode])

  // Unlock: verification runs in the main process (scrypt + failure backoff); the failure
  // reason is rendered in place by LockScreen
  const handleUnlock = useCallback(
    async (password: string): Promise<LockUnlockResult> => {
      try {
        const result = await requestUnlock(password)
        if (result.ok) {
          viewMessage('unlock-success', 'success', t('shell.unlock.success'))
        }
        return result
      } catch (error) {
        console.error('[lock-screen] Unlock verification failed:', error)
        viewMessage('unlock-error', 'error', t('shell.unlock.verifyFailed'))
        return { ok: false, reason: 'unavailable' }
      }
    },
    [viewMessage, t]
  )

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleLockScreen()
      }
    }

    document.addEventListener('keydown', handleKeyPress)

    return () => {
      document.removeEventListener('keydown', handleKeyPress)
    }
  }, [handleLockScreen])

  return (
    <MessageProvider>
      <AppShell />
      {locked && <LockScreen onUnlock={handleUnlock} />}
    </MessageProvider>
  )
}

export default React.memo(AppContent)
