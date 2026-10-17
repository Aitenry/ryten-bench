import React from 'react'
import PluginCrashCard, { type PluginSurface } from './PluginCrashCard'

// 兼容原来的导入路径：`PluginSurface` 与卡片一起搬到了 PluginCrashCard.tsx
export type { PluginSurface } from './PluginCrashCard'

/**
 * **单个插件的渲染隔离层**（宿主外壳与插件界面之间的最后一道闸）。
 *
 * 为什么必须有它：React 的错误边界是逐层兜底的，而宿主此前只有 `App.tsx` 最外面的
 * 那一个——插件页面/设置页/Provider 里任何一次渲染抛错都会一路冒到顶层，
 * 表现就是**整个应用变成「RUNTIME ERROR」卡片**。插件是第三方代码，它不该有这种权力：
 * 坏掉的只该是它自己那一块，菜单、侧栏、其它插件和设置页继续可用。
 *
 * 三种降级形态（按使用位置选）：
 * - **卡片**（route / settings）：显示是哪个插件坏了、错误原文，并给「重试 / 停用插件」；
 * - **静默跳过**（`quiet` + `fallback`，appProvider / bottomBar）：坏掉的 Provider 不再渲染，
 *   它包着的子树照常渲染（`fallback` 就是那棵子树）；底栏条目退化成占位。
 * - **完全静默**：不传 fallback 也不显示卡片（预留给没有可见界面的挂载点）。
 *
 * 注意：错误边界只能接住**渲染期**（含子组件挂载/更新）的错误。事件回调、定时器、
 * Promise 里的异常不在它的范围内——那是主进程 `plugin-guard` 与各插件自己 try/catch 的事。
 */

export interface PluginBoundaryProps {
  /** 出问题时用来停用/展示的插件 id */
  pluginId: string
  /** 出在哪个挂载点（日志里能直接定位） */
  surface: PluginSurface
  children: React.ReactNode
  /**
   * 出错时渲染的内容。Provider 用「它包着的子树」，底栏用占位；
   * 不传则退化成错误卡片。
   */
  fallback?: React.ReactNode
  /** true = 不显示错误卡片（只渲染 fallback）；用于不允许出现一整块提示的位置 */
  quiet?: boolean
}

interface PluginBoundaryState {
  error: Error | null
  /** 记下出错时是哪个插件：底栏轮播/路由切换会复用同一个边界实例，插件换了要复位 */
  pluginId: string
}

export class PluginBoundary extends React.Component<PluginBoundaryProps, PluginBoundaryState> {
  state: PluginBoundaryState = { error: null, pluginId: this.props.pluginId }

  static getDerivedStateFromError(error: Error): Partial<PluginBoundaryState> {
    return { error }
  }

  /** 实例被复用到另一个插件时清空错误（否则新插件会一直显示上一个插件的失败卡片） */
  static getDerivedStateFromProps(
    props: PluginBoundaryProps,
    state: PluginBoundaryState
  ): Partial<PluginBoundaryState> | null {
    if (state.pluginId !== props.pluginId) {
      return { pluginId: props.pluginId, error: null }
    }
    return null
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[plugin:${this.props.pluginId}] ${this.props.surface} 渲染失败（已隔离，宿主继续运行）:`,
      error,
      info.componentStack
    )
  }

  /** 重试：清掉错误状态，用同一棵子树再渲染一次（对瞬时错误有效；再炸还会被接住） */
  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    if (this.props.quiet) return null
    return (
      <PluginCrashCard
        pluginId={this.props.pluginId}
        surface={this.props.surface}
        error={error}
        onRetry={this.handleRetry}
      />
    )
  }
}
