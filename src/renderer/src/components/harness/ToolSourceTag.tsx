import React, { useLayoutEffect } from 'react'
import { useTranslation } from '@renderer/i18n'

/**
 * 工具来源标记（与主进程 `ToolSourceKind` / `HarnessToolInfo.source` 同值）。
 *
 * - `system`：随应用编译的工具（harness 本地工具 + 内置的资料整理）；
 * - `plugin`：第三方插件经 `harness.tool` 贡献点注册的工具（停用插件即消失）；
 * - `mcp`：外部 MCP 服务器暴露的工具（既不是系统也不是插件）。
 */
export type ToolSourceKind = 'system' | 'plugin' | 'mcp'

/**
 * 工具清单（输入框工具面板、智能体页、定时任务页）里**名称最右边的小胶囊**。
 *
 * 用户口径 2026-11-27：「在其名称最右边增加一个标签来区分是系统工具还是插件工具」——
 * 之前两类工具混在同一张清单里、长得一模一样，用户没法判断勾的这一项是应用自带的，
 * 还是装某个插件才有的（插件一停用那项就消失，看着像工具凭空没了）。
 *
 * 只做展示：`source` 由主进程在组装清单时写入（`main/tools/harness/builders.ts` 的
 * `toolSources`），插件自己声明不了——否则插件把自己标成「系统」就骗过了用户。
 * 样式在这里一次性注入（与 `TopicStatusDot` 同一做法），不占全局样式表。
 */
export const TOOL_SOURCE_TAG_CSS = `
.ryt-tool-source {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border: 1px solid rgba(140, 140, 140, 0.45);
  border-radius: 999px;
  background: rgba(140, 140, 140, 0.1);
  color: #8c8c8c;
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.02em;
  white-space: nowrap;
  user-select: none;
}
.ryt-tool-source[data-source='plugin'] {
  border-color: rgba(114, 46, 209, 0.42);
  background: rgba(114, 46, 209, 0.1);
  color: #854eca;
}
.ryt-tool-source[data-source='mcp'] {
  border-color: rgba(212, 136, 6, 0.45);
  background: rgba(212, 136, 6, 0.1);
  color: #ad6800;
}
/* 深色主题：同色系提亮，保证在深灰底上仍然可读 */
.dark .ryt-tool-source {
  color: #a6a6a6;
  border-color: rgba(166, 166, 166, 0.4);
  background: rgba(166, 166, 166, 0.12);
}
.dark .ryt-tool-source[data-source='plugin'] {
  color: #b37feb;
  border-color: rgba(179, 127, 235, 0.45);
  background: rgba(179, 127, 235, 0.14);
}
.dark .ryt-tool-source[data-source='mcp'] {
  color: #e8b339;
  border-color: rgba(232, 179, 57, 0.45);
  background: rgba(232, 179, 57, 0.12);
}
/* 下拉项：名称后面紧跟来源标签（antd Select 的 optionRender 里用） */
.ryt-tool-option {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
}
.ryt-tool-option__label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
`

let tagCssInjected = false

interface ToolSourceTagProps {
  /** 工具来源；缺省（旧数据 / 非工具清单行）时不渲染，避免出现空胶囊 */
  source?: ToolSourceKind
}

const ToolSourceTag: React.FC<ToolSourceTagProps> = ({ source }) => {
  const { t } = useTranslation()

  useLayoutEffect(() => {
    if (tagCssInjected) return
    tagCssInjected = true
    const style = document.createElement('style')
    style.textContent = TOOL_SOURCE_TAG_CSS
    document.head.appendChild(style)
  }, [])

  if (!source) return null
  return (
    <span className="ryt-tool-source" data-source={source}>
      {t(`harness.toolSource.${source}`)}
    </span>
  )
}

export default ToolSourceTag
