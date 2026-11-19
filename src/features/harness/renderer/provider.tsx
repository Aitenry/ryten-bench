import type { AppProviderRegistration } from '@renderer/plugin-host/types'
import { HarnessProvider } from './contexts/HarnessContext'

/**
 * harness 的 appProvider 注册载荷：
 * 把 HarnessProvider 从 App.tsx 静态组合中抽离，改由插件安装时动态挂到 Provider 层。
 * 停用 harness 后该 Provider 立即从组合树中摘除。
 *
 * HarnessContext 本体就在本插件的 `renderer/contexts/HarnessContext.tsx`，外壳不 import 它。
 */
export const harnessAppProvider: Omit<AppProviderRegistration, 'pluginId'> = {
  Provider: HarnessProvider,
  order: 0
}
