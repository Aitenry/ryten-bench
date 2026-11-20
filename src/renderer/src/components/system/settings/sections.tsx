import type React from 'react'
import {
  RiAiAgentLine,
  RiBrain4Line,
  RiFileAi2Line,
  RiMindMap,
  RiPlug2Line
} from '@remixicon/react'
import AgentSettings from '@renderer/components/harness/settings/AgentSettings'
import SkillsSettings from '@renderer/components/harness/settings/SkillsSettings'
import MemorySettings from '@renderer/components/harness/settings/MemorySettings'
import McpSettings from '@renderer/components/harness/settings/McpSettings'
import GraphSettings from '@renderer/components/notes/settings/GraphSettings'

/**
 * 设置弹窗里的**系统功能页**（AI 助手 / 资料库）。
 *
 * 这些页面随应用一起编译进来，不经过插件注册表：没有 pluginId、没有启用态、
 * 也不会因为“停用某个插件”而消失。第三方插件的设置页在插件仓库里，不在这里。
 */
export interface SystemSettingsSection {
  tabKey: string
  labelKey: string
  icon: React.ReactNode
  /** 导航分组（`assistant` = 助手相关；`general` = 应用通用） */
  group: 'assistant' | 'general'
  order: number
  Component: React.ComponentType
}

export const systemSettingsSections: SystemSettingsSection[] = [
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
