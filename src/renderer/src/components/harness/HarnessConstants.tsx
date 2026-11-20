import {
  RiSunCloudyLine,
  RiTimeLine,
  RiListCheck3,
  RiFileSearchLine,
  RiBook2Line,
  RiMindMap,
  RiBarChartHorizontalLine,
  RiPlayListLine,
  RiPlug2Line
} from '@remixicon/react'
import React from 'react'

export const toolIconMap: Record<string, React.ReactNode> = {
  RiSunCloudyLine: <RiSunCloudyLine size={16} />,
  RiTimeLine: <RiTimeLine size={16} />,
  RiListCheck3: <RiListCheck3 size={16} />,
  RiFileSearchLine: <RiFileSearchLine size={16} />,
  RiBook2Line: <RiBook2Line size={16} />,
  RiMindMap: <RiMindMap size={16} />,
  RiBarChartHorizontalLine: <RiBarChartHorizontalLine size={16} />,
  RiPlayListLine: <RiPlayListLine size={16} />,
  // MCP 工具（外部服务器提供，图标名由主进程 runtime/mcp.ts 统一给出）
  RiPlug2Line: <RiPlug2Line size={16} />
}
