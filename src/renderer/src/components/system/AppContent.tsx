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
 * 应用内容层：外壳 + 锁屏。
 *
 * 锁屏状态不再由这里的 `useState` 持有（旧实现刷新页面就解锁）：
 * `locked` 来自主进程快照（`lock-screen-state.ts`），验证/退避/自动锁屏也在主进程
 * （`src/main/lock/service.ts`）。这里只负责两件事：
 * - Esc 请求锁屏；
 * - 把解锁码转交主进程校验，并把失败结果交还锁屏界面展示。
 */
const AppContent: React.FC = () => {
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const { enabled, hasCode, locked } = useLockScreenState()

  /**
   * 挂主进程的锁屏推送 + 首次拉取。StrictMode 下会挂载两次，桥内部按引用计数
   * 只保留一个 IPC 监听，不会重复处理事件。
   */
  useEffect(() => installLockScreenBridge(), [])

  // Esc 手动锁屏：未启用 / 还没设置解锁码时主进程不会锁（宁可 Esc 没反应，也不能锁出
  // 一个进不去的界面）
  const handleLockScreen = useCallback((): void => {
    if (!enabled || !hasCode) return
    void requestLock().catch((error) => {
      console.error('[lock-screen] Failed to request lock:', error)
    })
  }, [enabled, hasCode])

  // 解锁：校验在主进程（scrypt + 失败退避）；失败原因交给 LockScreen 就地展示
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
