/**
 * 设置弹窗的状态（模块级可订阅快照）。
 *
 * 为什么不放在 `CustomFrame` / `SettingsModal` 的 useState 里：插件自己的 Provider 随插件装卸
 * （`ctx.use('appProvider')`），而 Provider 增删会让 `PluginProvidersShell` 之下的整棵外壳子树
 * 重挂（React 的类型调和语义，见 App.tsx 里 PluginProvidersShell 的注释）。状态留在组件里时：
 * - 停用任意注册了 Provider 的插件（music / harness）会把用户正在看的设置弹窗直接关掉；
 * - 更隐蔽的是**当前页签**也会被重置——齿轮打开时 `tab` 是 undefined，重挂后就会回落到
 *   首个可用页签（2026-09-26 用户实测：「点插件开关会刷新设置内容并跳回通用」）。
 *
 * 因此弹窗的「开着没 / 在哪一页」两件事全部外置到这里：
 * `SettingsModal` 只按注册表把 `tab` 解析成实际可用的页签（页签随插件启停增删）。
 */
export interface SettingsModalState {
  open: boolean
  /** 当前页签（undefined = 交给 SettingsModal 解析为首个可用页签） */
  tab: string | undefined
}

let state: SettingsModalState = { open: false, tab: undefined }
const listeners = new Set<() => void>()

export function getSettingsModalState(): SettingsModalState {
  return state
}

export function subscribeSettingsModalState(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

function publish(patch: Partial<SettingsModalState>): void {
  state = { ...state, ...patch }
  for (const onChange of [...listeners]) {
    try {
      onChange()
    } catch (err) {
      console.error('[settings] 弹窗状态订阅回调异常:', err)
    }
  }
}

/** 打开设置弹窗（tab 缺省 = 首个可用页签） */
export function openSettingsModal(tab?: string): void {
  publish({ open: true, tab })
}

/**
 * 切换当前页签（侧栏导航点击）。
 *
 * 必须是模块级写入：外壳子树重挂会重建 `SettingsModal`，页签若只存在组件 state 里就会丢。
 * 页签本身随插件启停增删，失效的 tab 由 `SettingsModal` 的解析逻辑回退到首个可用页签。
 */
export function setSettingsModalTab(tab: string | undefined): void {
  if (state.tab === tab) return
  publish({ tab })
}

export function closeSettingsModal(): void {
  publish({ open: false })
}
