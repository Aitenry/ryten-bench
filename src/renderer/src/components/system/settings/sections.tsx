import type React from 'react'
import {
  RiAiAgentLine,
  RiBrain4Line,
  RiFileAi2Line,
  RiMindMap,
  RiPlug2Line,
  RiSearchLine
} from '@remixicon/react'
import AgentSettings from '@renderer/components/harness/settings/AgentSettings'
import SkillsSettings from '@renderer/components/harness/settings/SkillsSettings'
import MemorySettings from '@renderer/components/harness/settings/MemorySettings'
import McpSettings from '@renderer/components/harness/settings/McpSettings'
import SearchSettings from '@renderer/components/harness/settings/SearchSettings'
import GraphSettings from '@renderer/components/notes/settings/GraphSettings'

/**
 * Settings page registry (AI assistant / knowledge base).
 *
 * - The `assistant` group (agents / skills / memory / MCP) renders on the separate "More" page
 *   (pages/More.tsx);
 * - The `general` group (graph) stays in the regular group of the settings modal
 *   (SettingsModal.tsx).
 *
 * These pages are compiled into the app and do not go through the plugin registry: no pluginId, no
 * enabled state, and they do not disappear because "some plugin is disabled". Third-party plugin
 * settings pages live in the plugin repository, not here.
 */
export interface SystemSettingsSection {
  tabKey: string
  labelKey: string
  /** Page-header description key (used by the "More" page hero; in the modal the page's own SettingsPageHeader renders it) */
  descriptionKey?: string
  icon: React.ReactNode
  /** Nav group (`assistant` = assistant-related; `general` = app-generic) */
  group: 'assistant' | 'general'
  order: number
  Component: React.ComponentType
}

export const systemSettingsSections: SystemSettingsSection[] = [
  {
    tabKey: 'agents',
    labelKey: 'settings.nav.agents',
    descriptionKey: 'agentSettings.pageDescription',
    icon: <RiAiAgentLine size={16} />,
    group: 'assistant',
    order: 10,
    Component: AgentSettings
  },
  {
    tabKey: 'skills',
    labelKey: 'settings.nav.skills',
    descriptionKey: 'skillsSettings.pageDescription',
    icon: <RiFileAi2Line size={16} />,
    group: 'assistant',
    order: 20,
    Component: SkillsSettings
  },
  {
    tabKey: 'memory',
    labelKey: 'settings.nav.memory',
    descriptionKey: 'memorySettings.page.description',
    icon: <RiBrain4Line size={16} />,
    group: 'assistant',
    order: 30,
    Component: MemorySettings
  },
  {
    tabKey: 'mcp',
    labelKey: 'settings.nav.mcp',
    descriptionKey: 'mcpSettings.pageDescription',
    icon: <RiPlug2Line size={16} />,
    group: 'assistant',
    order: 40,
    Component: McpSettings
  },
  {
    tabKey: 'search',
    labelKey: 'settings.nav.search',
    descriptionKey: 'searchSettings.pageDescription',
    icon: <RiSearchLine size={16} />,
    group: 'general',
    order: 30,
    Component: SearchSettings
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
