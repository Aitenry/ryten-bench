import React, { lazy, useEffect } from 'react'
import {
  RiAiAgentLine,
  RiBrain4Line,
  RiFileAi2Line,
  RiMindMap,
  RiPlug2Line
} from '@remixicon/react'
import type {
  AppProviderRegistration,
  SettingsSectionRegistration
} from '@renderer/plugin-host/types'
import { HarnessProvider } from '@features/harness/renderer/contexts/HarnessContext'
import AgentSettings from '@features/harness/renderer/components/settings/AgentSettings'
import SkillsSettings from '@features/harness/renderer/components/settings/SkillsSettings'
import MemorySettings from '@features/harness/renderer/components/settings/MemorySettings'
import McpSettings from '@features/harness/renderer/components/settings/McpSettings'
import { harnessApi } from '@features/harness/renderer/api'
import { handleProbeRequest } from '@features/harness/renderer/workshop/probe'
import BuildProgressProvider from '@features/notes/renderer/providers/BuildProgressProvider'
import GraphSettings from '@features/notes/renderer/settings/GraphSettings'
import { publishDocChanged, type DocChangedPayload } from '@features/notes/renderer/doc-changed'

/**
 * harness / notes 已从插件系统移出，改为系统级功能。
 *
 * 这里集中声明它们的系统装配面：
 * - 路由：/harness（对话）、/notes（资料库）
 * - Provider：HarnessProvider（会话状态）、BuildProgressProvider（图谱构建进度）
 * - 设置页：智能体 / 技能 / 记忆 / MCP / 图谱
 * - 跨功能副作用：AI 改写文档通知、插件工坊渲染探针
 *
 * 插件宿主不再认识这两个功能；第三方插件仍走 `plugin-host`。
 *
 * 注意：「插件工坊」不属于设置页——它是**插件仓库**里的一个视图（用户 2026-11-19
 * 口径「移除设置里面的这两个内容，放到插件仓库里面设置」），见 pages/PluginRepository。
 */

export interface SystemRouteDef {
  path: string
  load: () => Promise<{ default: React.ComponentType }>
}

export const systemRoutes: SystemRouteDef[] = [
  { path: '/harness', load: () => import('@features/harness/renderer/Index') },
  { path: '/notes', load: () => import('@features/notes/renderer/Index') }
]

/** 模块级 lazy 组件：不能在渲染期新建 lazy（会让 Suspense 反复重试） */
export const systemRouteViews = systemRoutes.map((route) => ({
  path: route.path,
  Component: lazy(route.load)
}))

export const systemProviders: Array<Omit<AppProviderRegistration, 'pluginId'>> = [
  { Provider: HarnessProvider, order: 0 },
  { Provider: BuildProgressProvider, order: 10 }
]

export const systemSettingsSections: Array<Omit<SettingsSectionRegistration, 'pluginId'>> = [
  {
    tabKey: 'agents',
    labelKey: 'settings.nav.agents',
    icon: <RiAiAgentLine size={16} />,
    group: 'assistant',
    order: 10,
    Component: AgentSettings
  },
  {
    tabKey: 'skills',
    labelKey: 'settings.nav.skills',
    icon: <RiFileAi2Line size={16} />,
    group: 'assistant',
    order: 20,
    Component: SkillsSettings
  },
  {
    tabKey: 'memory',
    labelKey: 'settings.nav.memory',
    icon: <RiBrain4Line size={16} />,
    group: 'assistant',
    order: 30,
    Component: MemorySettings
  },
  {
    tabKey: 'mcp',
    labelKey: 'settings.nav.mcp',
    icon: <RiPlug2Line size={16} />,
    group: 'assistant',
    order: 40,
    Component: McpSettings
  },
  {
    tabKey: 'graph',
    labelKey: 'settings.nav.graph',
    icon: <RiMindMap size={16} />,
    group: 'general',
    order: 40,
    Component: GraphSettings
  }
]

/**
 * 系统级副作用（挂载一次）：
 * - harness 主进程写文档 → notes 编辑器的 `doc:changed` 订阅表；
 * - 插件工坊对插件渲染模块的实时探针。
 *
 * 旧的插件事件总线不再参与：两者都是系统功能，直接调用公开的模块 API。
 */
export const SystemEffects: React.FC = () => {
  useEffect(() => {
    const unsubDoc = harnessApi.harness.onDocChanged((data) => {
      publishDocChanged(data as DocChangedPayload)
    })
    const unsubProbe = harnessApi.workshop.onProbe((payload) => {
      void handleProbeRequest(payload)
    })
    return () => {
      unsubDoc?.()
      unsubProbe?.()
    }
  }, [])
  return null
}
