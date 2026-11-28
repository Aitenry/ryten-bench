import { tool, type StructuredToolInterface } from '../../ai/tools'
import * as z from 'zod/v4'
import type { ToolInfo } from '../../plugins/tool-contract'

/**
 * AI tool for the plugin center (Lattice): **release a version**.
 *
 * Division of labor with the four workshop tools:
 * - `plugin_build` / `plugin_verify` / `plugin_publish` all run locally — build the artifact, run
 *   verification, install it into the current app;
 * - `plugin_release` is the final, **outward-facing** step: package the current plugin (install
 *   package + source package) and publish it to the plugin center, so other users can install it.
 *
 * Why it is attached to plugin mode: only a plugin session has an unambiguous "plugin currently
 * being edited", and people usually go from "it works" to "let me publish a version"; they
 * should not have to switch to the plugin detail page and type the version number by hand.
 *
 * **Registered only when signed in**: the tool names for the round are decided by
 * `effectiveMainAgentTools(…, { signedIn })` in `shared/mcp.ts` (the main process reads the
 * sign-in state via `hasLatticeSession()`); when signed out, plugin mode does not attach this
 * tool at all — otherwise the model would call a tool that is guaranteed to return 401 and might
 * mistake "not signed in" for "publishing failed". The tool checks sign-in once more internally
 * so that an instance constructed elsewhere cannot bypass that layer.
 *
 * Publishing **does not change the local install**: installing into the current app is still
 * `plugin_publish install`.
 */
export const latticeToolInfos: ToolInfo[] = [
  {
    name: 'plugin_release',
    label: '发布版本',
    description: '把插件发布一个新版本到插件中心（需登录）',
    icon: 'RiSendPlaneLine',
    color: '#2f54eb'
  }
]

const releaseTool = (): StructuredToolInterface =>
  tool(
    async (input: {
      id: string
      version: string
      changelog?: string
      sourceDir?: string
    }): Promise<string> => {
      // Wrap the whole body: a thrown tool error turns the entire turn into a framework error,
      // and the model gets no actionable next step.
      // Sign-in: the registration layer already filtered by sign-in state; this is a fallback
      // (an instance constructed directly / signing out while a release is in progress).
      try {
        const { hasLatticeSession } = await import('../../lattice/session')
        if (!hasLatticeSession()) {
          return 'plugin_release 失败：插件中心未登录。请让用户在「插件中心」登录后再发布版本。'
        }
        const { republishLatticePlugin } = await import('../../lattice/hub')
        const changelog = input.changelog?.trim()
        const sourceDir = input.sourceDir?.trim()
        const result = await republishLatticePlugin({
          pluginId: input.id,
          version: input.version,
          ...(changelog ? { changelog } : {}),
          ...(sourceDir ? { sourceDir } : {})
        })
        if (!result.ok) return `plugin_release 失败：${result.error}`
        const lines = [
          result.status === 'review'
            ? `已提交 ${result.plugin_id}@${result.version} 到插件中心，等待管理员审核（审核通过后其他用户才装得到）。`
            : `已发布 ${result.plugin_id}@${result.version} 到插件中心，其他用户现在就能在插件中心看到并安装。`
        ]
        if (result.sourcePath) {
          lines.push(`源码包已随版本一起上传（源码目录：${result.sourcePath}）。`)
        }
        lines.push(
          '本机源码的 plugin.json 版本号会同步成这次发布的版本（源码目录没有 plugin.json 时不动）。' +
            '要把这个版本装进**当前**应用，仍然用 plugin_publish install。'
        )
        return lines.join('\n')
      } catch (err) {
        return `plugin_release 失败：${(err as Error).message}`
      }
    },
    {
      name: 'plugin_release',
      description:
        'Publish a new version of a plugin to the plugin center (the hub), so that other users can install it. ' +
        'This is the external counterpart of plugin_publish, which only installs the plugin into the local app.\n' +
        'Requires the user to be signed in to the plugin center. The version must be semver and higher than the latest ' +
        'published version; the same version cannot be published twice with different content (409 -> bump the version). ' +
        'The install package and the source package are uploaded together; the workshop draft is rebuilt first when its ' +
        'build output is missing or stale. The platform may accept the version into review instead of publishing it live.\n' +
        'Only call this when the user explicitly asked to publish a version, and use exactly the version they asked for - ' +
        'never invent or bump a version on your own. Run plugin_verify first: do not release a build that failed verification.',
      schema: z.object({
        id: z.string().describe('插件 id'),
        version: z
          .string()
          .describe(
            '要发布的版本号（semver，必须高于插件中心当前最新版本，例如 1.4.2）。' +
              '用用户确认过的那个版本号，不要自己猜'
          ),
        changelog: z
          .string()
          .optional()
          .describe('更新说明（可选；不填就用 plugin.json 里的 changelog，再没有就是「发布 vX」）'),
        sourceDir: z
          .string()
          .optional()
          .describe('源码目录（可选；缺省按插件 id 找工坊草稿/源码缓存）')
      })
    }
  )

/** Plugin center tools (looked up by name from the local tool table in `tools/builders.ts`) */
export const latticeToolBuilders: Record<string, () => StructuredToolInterface> = {
  plugin_release: releaseTool
}
