/**
 * **Host contract** for AI tools (owned by core, referenced by both harness and plugins).
 *
 * Why a separate file: tool implementations belong to each plugin, and harness only provides the
 * contribution point for registration/consumption. If the contract lived in harness, plugins would
 * have to import harness in reverse; putting it in core (`src/main/plugins/**`) means both sides
 * depend only on the host.
 */
import type { StructuredToolInterface } from '../ai/tools'

/**
 * Contribution key: AI tools (used by **third-party plugins**).
 *
 * A plugin calls `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, toolItem)` in `install(ctx)`, and
 * harness calls `listContributions<PluginToolContribution>(HARNESS_TOOL_CONTRIBUTION)` when
 * assembling its tool set.
 *
 * Tools of built-in features (the 1 docs-organization tool) do not go through here: they are
 * registered by `src/main/system/notes.ts` calling `registerBuiltinHarnessTools()` directly,
 * compiled with the app and exiting with it.
 */
export const HARNESS_TOOL_CONTRIBUTION = 'harness.tool'

/**
 * Tool source (used by the source label to the right of the name in the settings page / input box
 * tool list):
 * - `system`: tools compiled into the app (harness local tools + built-in features registered by
 *   `registerBuiltinHarnessTools`);
 * - `plugin`: tools registered by third-party plugins through the `harness.tool` contribution
 *   point (they disappear when the plugin is disabled);
 * - `mcp`: tools exposed by external MCP servers (neither system nor plugin).
 *
 * harness **writes it by source** when assembling the tool list (plugin-contributed info has no
 * such field, and plugins should not declare it themselves - calling yourself "system" amounts to
 * masquerading as a built-in tool).
 */
export type ToolSourceKind = 'system' | 'plugin' | 'mcp'

/**
 * Display metadata for a tool in the settings page / prompts (the former `ToolInfo` of
 * `harness/types.ts`, moved here).
 *
 * Note: label/description are only **fallback** UI copy; before being sent out they are overridden
 * by `ipc/misc.ts` with `mainMessages().tools` in the current UI language. They are not the same
 * as the description the tool gives the model.
 */
export interface ToolInfo {
  name: string
  label: string
  description: string
  icon: string
  color: string
  /** Source label; missing is treated as unknown (no label shown), see `ToolSourceKind` */
  source?: ToolSourceKind
}

/** An AI tool contributed to harness (contributed by third-party plugins, or registered by built-in features) */
export interface PluginToolContribution {
  /** Tool name (= the name used by the settings page and prompt index, e.g. `manage_planner`) */
  name: string
  /** Display metadata for the settings page / prompts */
  info: ToolInfo
  /**
   * Actually build the AI tool instance (**deferred until needed**: when the plugin is not
   * enabled/loaded it is never called, so the tool may safely read its own plugin's mapper inside).
   */
  build: () => StructuredToolInterface
}
