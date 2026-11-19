// AppContent.tsx
import React, { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import AppShell from '@renderer/components/system/shell/AppShell'
import LockScreen from '@renderer/components/system/LockScreen'
import CryptoJS from 'crypto-js'
import { Window } from '../../../resource/types/window'
import { MessageProvider } from '@renderer/providers/MessageProvider'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from '@renderer/i18n'
import {
  getLockScreenState,
  setLockScreenState,
  subscribeLockScreenState
} from './lock-screen-state'

const AppContent: React.FC = () => {
  const { viewMessage } = useMessage()
  const { t } = useTranslation()
  const [isLocked, setIsLocked] = useState(false)
  /**
   * 锁屏开关 / 解锁码来自**模块级共享快照**（见 lock-screen-state.ts）：
   * 设置页打开「启用锁屏」时立刻生效，不必等外壳重挂（那正是「开关打开后按 ESC 没反应」的根因）。
   */
  const { enabled: lockEnabled, code: lockCode } = useSyncExternalStore(
    subscribeLockScreenState,
    getLockScreenState
  )

  /**
   * 挂载时从主进程读一次**真源**（electron-store 的 `lock`）；此后与设置页通过共享快照同步。
   * 读失败按「不启用」兜底：解锁码未知时锁屏等于把人锁在进不去的界面里。
   */
  useEffect(() => {
    let cancelled = false
    const initializeLockScreen = async (): Promise<void> => {
      try {
        const result = await (window as unknown as Window).api.setting.getLockScreenCode()
        if (cancelled) return
        setLockScreenState({ enabled: result?.view ?? false, code: result?.code ?? null })
      } catch (error) {
        console.error('Failed to initialize lock screen:', error)
        if (!cancelled) setLockScreenState({ enabled: false })
      }
    }

    initializeLockScreen().then()

    return () => {
      cancelled = true
    }
  }, [])

  // Update lock screen status locally (runtime state only)
  const updateLockStatus = useCallback((locked: boolean): void => {
    setIsLocked(locked)
  }, [])

  // Handle lock screen action
  const handleLockScreen = useCallback((): void => {
    // 开关关着、或还没拿到解锁码时不锁屏（宁可 ESC 没反应，也不能锁出一个进不去的界面）
    if (!lockEnabled || !lockCode) return
    updateLockStatus(true)
  }, [updateLockStatus, lockEnabled, lockCode])

  // Verify password against stored hash
  const verifyPassword = async (inputPassword: string): Promise<boolean> => {
    if (!lockCode) return false

    const encryptedPassword = CryptoJS.MD5(inputPassword).toString()
    return encryptedPassword === lockCode
  }

  // Handle unlock process
  const handleUnlock = async (password: string): Promise<void> => {
    try {
      const isValid = await verifyPassword(password)

      if (isValid) {
        updateLockStatus(false)
        viewMessage('unlock-success', 'success', t('shell.unlock.success'))
      } else {
        viewMessage('unlock-error', 'error', t('shell.unlock.failed'))
      }
    } catch (error) {
      console.error('Unlock verification failed:', error)
      viewMessage('unlock-error', 'error', t('shell.unlock.verifyFailed'))
    }
  }

  // 侧栏高亮不再需要「与路由同步」的 effect：current 本身就是 location 的派生值
  // （此前是 useState + 同步 effect，重挂后会丢状态）

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
      {isLocked && <LockScreen onUnlock={handleUnlock} />}
    </MessageProvider>
  )
}

export default React.memo(AppContent)
