import React, { useLayoutEffect } from 'react'
import { useTranslation } from '@renderer/i18n'

/**
 * Tool source marker (holds the same values as the main process `ToolSourceKind` /
 * `HarnessToolInfo.source`).
 *
 * - `system`: tools compiled with the app (harness local tools + built-in material organizing);
 * - `plugin`: tools registered by third-party plugins through the `harness.tool` contribution
 *   point (disappear when the plugin is disabled);
 * - `mcp`: tools exposed by external MCP servers (neither system nor plugin).
 */
export type ToolSourceKind = 'system' | 'plugin' | 'mcp'

/**
 * The **small pill at the far right of the name** in tool lists (input tool panel, agent page,
 * schedule page).
 *
 * User requirement 2026-11-27: "add a tag to the right of its name to distinguish system tools
 * from plugin tools" — previously the two kinds were mixed in one list and looked identical, so
 * users could not tell whether the checked item shipped with the app or only existed because a
 * plugin was installed (once the plugin is disabled that item vanishes, so the tool seems to
 * disappear into thin air).
 *
 * Display only: `source` is written by the main process while assembling the list
 * (`toolSources` in `main/tools/harness/builders.ts`); a plugin cannot declare it itself —
 * otherwise a plugin could label itself "system" and fool the user. Styles are injected here
 * once (same approach as `TopicStatusDot`), not in the global stylesheet.
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
/* Dark theme: brighten within the same hue so it stays readable on dark gray backgrounds */
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
/* Dropdown option: the source tag sits right after the name (used in antd Select's optionRender) */
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
  /** Tool source; when omitted (legacy data / non-tool-list rows) nothing renders, avoiding an empty pill */
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
