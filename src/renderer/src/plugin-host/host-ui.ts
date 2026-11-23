import React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as antd from 'antd'
import dayjs from 'dayjs'
import * as RemixIcons from '@remixicon/react'
import * as AntIcons from '@ant-design/icons'

import * as i18n from '@renderer/i18n'
import { useMessage } from '@renderer/hooks/useMessage'
import { useNotification } from '@renderer/hooks/useNotification'
import { useTheme } from '@renderer/hooks/useTheme'
import * as SettingsUI from '@renderer/components/system/settings/SettingsUI'
import * as Skeleton from '@renderer/components/system/Skeleton'
import * as formatTime from '@renderer/utils/formatTime'
import RouteSkeleton from '@renderer/route/RouteSkeleton'
import MarkdownView, { InlineCodeCopy } from '@renderer/components/markdown/MarkdownView'
import MarkdownLoad from '@renderer/components/markdown/MarkdownLoad'
import TipTapMarkdownEditor from '@renderer/components/markdown/TipTapMarkdownEditor'
import { ShinyText, ShinyIcon } from '@renderer/components/effects/ShinyText'
import ProviderMark from '@renderer/components/provider/provider-mark'
import * as documentUtils from '@renderer/utils/document'
import * as providerMeta from '@renderer/utils/providerMeta'

/**
 * 渲染层**宿主 UI 表**（插件打包方案见 src/main/workshop/README.md）。
 *
 * 背景：插件包（`userData/plugins/<id>/renderer.mjs`）不能各自再打一份 React / antd /
 * i18n —— 那会得到第二个 React 实例（hooks 直接崩）、与宿主不同的 antd 主题上下文、
 * 互不可见的 i18n 词条。因此打包时把插件源码里指向宿主 UI 的导入与第三方 vendor 都
 * 改写成 `plugin://host/ui.js?m=<key>`，由主进程的协议处理器动态生成 ESM 桥，
 * 桥里的每个导出都指向**宿主这里的同一份实例**。
 *
 * 键的两种形态（与工坊构建产物一致）：
 * - `@host/renderer/<相对 src/renderer/src 的路径，无扩展名>`：宿主 UI 模块；
 * - `@host/vendor/<包名>`：宿主里的第三方 vendor 唯一实例。
 *
 * **导出名必须显式列出，不能靠 `Object.keys(模块对象)` 猜**（2026-09-26 实测踩坑）：
 * `src/renderer/src/i18n/index.ts` 的默认导出是 i18next 实例，`import * as ns` 拿到的是
 * **实例对象**而不是模块命名空间 —— `Object.keys(ns)` 全是 i18next 自己的属性
 * （`t`/`use`/`init`…），`ns.useTranslation` 是 undefined。桥按这份名单生成
 * `export const X = m["X"]`，名单错了插件在运行期就拿到 undefined。
 * `assertHostUiShape()` 在启动时会核对名单，缺名字会在控制台点名（而不是等插件白屏）。
 *
 * vendor（react/antd/图标）是真正的打包产物命名空间，用 `Object.keys` 枚举是可靠的：
 * 它们由宿主打包器产出，键就是导出名。例外是 **dayjs**：它只有默认导出（见下表内的说明），
 * 因此和宿主 UI 模块一样显式写名单。
 */
export interface HostUiEntry {
  /** 模块实例（插件的 import 最终取的就是这个对象） */
  module: unknown
  /** 该键允许插件具名导入的导出名（`default` 不需要列，桥会额外提供） */
  names: string[]
}

/** vendor 命名空间：键即导出名 */
const vendor = (mod: unknown): HostUiEntry => ({
  module: mod,
  names:
    typeof mod === 'object' && mod !== null
      ? Object.keys(mod).filter((k) => k !== 'default' && !k.startsWith('_') && k !== '__esModule')
      : []
})

/** 宿主 UI 模块：显式列导出名（见上方注释） */
const hostModule = (mod: unknown, names: string[]): HostUiEntry => ({ module: mod, names })

/**
 * 宿主 UI / vendor 表。
 *
 * `react/jsx-runtime` 与 `react` 指向同一份 React（react-jsx-runtime 内部
 * `require('react')`），因此 `<div/>` 的自动 JSX 运行时与 `useState` 绝不会分裂。
 */
export const HOST_UI: Record<string, HostUiEntry> = {
  // ---------- 宿主 UI 模块 ----------
  '@host/renderer/i18n': hostModule(i18n, [
    'i18n',
    'useTranslation',
    'Trans',
    'DEFAULT_NS',
    'DEFAULT_LANGUAGE',
    'SUPPORTED_LANGUAGES',
    'LANGUAGES',
    'resources',
    'applyLanguageGlobals',
    'changeLanguage',
    'normalizeLanguage',
    'isSupportedLanguage',
    'detectSystemLanguage'
  ]),
  '@host/renderer/hooks/useMessage': hostModule({ useMessage }, ['useMessage']),
  '@host/renderer/hooks/useNotification': hostModule({ useNotification }, ['useNotification']),
  '@host/renderer/hooks/useTheme': hostModule({ useTheme }, ['useTheme']),
  '@host/renderer/components/system/settings/SettingsUI': hostModule(SettingsUI, [
    'SettingsPageHeader',
    'SettingsSection',
    'SettingRow',
    'SettingBlock'
  ]),
  '@host/renderer/components/system/Skeleton': hostModule(Skeleton, [
    'SkeletonStyle',
    'SkeletonBlock',
    'SkeletonTextLines',
    'SkeletonListRows',
    'SkeletonSettingRows',
    'SkeletonMessages',
    'SkeletonGraph',
    'SkeletonDashboard',
    'SkeletonDocPane',
    'SkeletonTodoPane'
  ]),
  '@host/renderer/utils/formatTime': hostModule(formatTime, ['formatTime']),
  '@host/renderer/utils/document': hostModule(documentUtils, ['getTagsArray']),
  '@host/renderer/utils/providerMeta': hostModule(providerMeta, [
    'CONTEXT_WINDOW_PRESETS',
    'MAX_OUTPUT_PRESETS',
    'FALLBACK_CONTEXT_WINDOW',
    'FALLBACK_MAX_OUTPUT_TOKENS',
    'DEFAULT_MAX_TOOL_ROUNDS',
    'THINKING_MODE_OPTIONS',
    'SAMPLING_PARAM_SPECS',
    'TOP_K_PROVIDERS',
    'supportsThinkingControl',
    'REASONING_EFFORT_ORDER',
    'REASONING_EFFORT_PRESETS',
    'defaultReasoningEffort',
    'supportsReasoningEffort',
    'reasoningEffortLabel',
    'sortReasoningEfforts',
    'formatTokenCount',
    'CAPABILITY_OPTIONS',
    'CAPABILITY_BADGES',
    'getCapabilities',
    'isEmbeddingProvider',
    'supportsCapability',
    'getProviderDisplayName',
    'PROVIDER_BRAND_COLORS',
    'getProviderColor',
    'getProviderMonogram'
  ]),
  '@host/renderer/route/RouteSkeleton': hostModule({ default: RouteSkeleton }, []),
  '@host/renderer/components/markdown/MarkdownView': hostModule(
    { default: MarkdownView, InlineCodeCopy },
    ['InlineCodeCopy']
  ),
  '@host/renderer/components/markdown/MarkdownLoad': hostModule({ default: MarkdownLoad }, []),
  '@host/renderer/components/markdown/TipTapMarkdownEditor': hostModule(
    { default: TipTapMarkdownEditor },
    []
  ),
  '@host/renderer/components/effects/ShinyText': hostModule(
    // ShinyText 必须同时给具名与默认：harness 插件里是 `import { ShinyText, ShinyIcon }`，
    // 只给 default 时桥里没有 `ShinyText` 这个绑定 → 运行期 undefined → JSX 直接抛
    // 「Element type is invalid」（test/verify-plugin-host-ui-exports.mjs 就是防这一类）。
    { default: ShinyText, ShinyText, ShinyIcon },
    ['ShinyText', 'ShinyIcon']
  ),
  '@host/renderer/components/provider/provider-mark': hostModule({ default: ProviderMark }, []),

  // ---------- vendor（宿主里的唯一实例） ----------
  '@host/vendor/react': vendor(React),
  '@host/vendor/react/jsx-runtime': vendor(ReactJsxRuntime),
  '@host/vendor/react-dom': vendor(ReactDom),
  '@host/vendor/react-dom/client': vendor(ReactDomClient),
  '@host/vendor/antd': vendor(antd),
  '@host/vendor/@remixicon/react': vendor(RemixIcons),
  '@host/vendor/@ant-design/icons': vendor(AntIcons),
  /**
   * dayjs 只有**默认导出**（可调用对象，静态方法挂在它自己身上）。
   *
   * 这里刻意不用 `vendor(dayjs)`：`vendor()` 用 `Object.keys` 枚举命名导出，而 dayjs 是函数、
   * 拿到的是空名单（结果一样但语义含糊）。写成 `hostModule({ default: dayjs }, [])` 明说
   * 「插件只能 `import dayjs from 'dayjs'`」，桥会生成 `export default m.default ?? m`。
   *
   * 为什么必须走桥（P2 实测）：宿主 `@renderer/i18n` import 了 dayjs 并全局设过 locale；
   * 插件自带第二份会得到另一个 Dayjs 类，`isDayjs()`、antd DatePicker 受控值与 locale 全部分裂。
   */
  '@host/vendor/dayjs': hostModule({ default: dayjs }, [])
}

/** 宿主 UI 表里的全部模块键（渲染层 loader 据此判断哪些说明符该走桥） */
export function hostUiKeys(): string[] {
  return Object.keys(HOST_UI)
}

/**
 * 宿主 vendored 实例（`ctx.require(name)` 那条老路径的表）。
 *
 * 第三方插件如果在自己的构建里把 react/antd 标成 external，就靠这张表拿到宿主**唯一**的那份实例，
 * 杜绝双重 React / antd 上下文分裂。P5 起四个内置插件都走 `@host/vendor/<spec>` 桥（同一批实例，
 * 见上表），这里保留是为了仍用 `ctx.require` 的老式第三方插件（兼容路径，仓内已无示例）。
 *
 * 与 HOST_UI 里 `@host/vendor/*` 指向的是**同一次 import**，因此两份表不会给出两个 React。
 */
export const vendorModules: Record<string, unknown> = {
  react: React,
  antd,
  '@remixicon/react': RemixIcons
}

/**
 * 核对表里声明的导出名是否真的存在于模块上（名单写错的早期发现手段）。
 *
 * 只告警不抛错：少一个名字最多让某个插件加载失败并报点名错误，不该连累宿主启动。
 */
export function assertHostUiShape(): void {
  const problems: string[] = []
  for (const [key, entry] of Object.entries(HOST_UI)) {
    if (typeof entry.module !== 'object' || entry.module === null) continue
    const shape = entry.module as Record<string, unknown>
    for (const name of entry.names) {
      if (!(name in shape)) problems.push(`${key} missing export '${name}'`)
    }
  }
  if (problems.length > 0) {
    console.warn(
      `[plugin-host] Host UI table declarations do not match actual modules (${problems.length} mismatches, plugins will fail to load):\n  ` +
        problems.join('\n  ')
    )
  }
}

/**
 * 挂表 + 把键与导出名报给主进程（协议处理器据此生成 ESM 桥）。
 */
export function installHostUi(): void {
  assertHostUiShape()
  ;(globalThis as typeof globalThis & { __RB_HOST_UI__?: Record<string, unknown> }).__RB_HOST_UI__ =
    Object.fromEntries(Object.entries(HOST_UI).map(([k, v]) => [k, v.module]))

  const names = Object.fromEntries(Object.entries(HOST_UI).map(([k, v]) => [k, v.names]))
  try {
    window.api.plugin.reportHostUi(names)
  } catch (err) {
    // 不抛：宿主 UI 表本身已经可用（vendor 桥仍能工作），只是 host 桥会报可读错误
    console.warn('[plugin-host] Failed to report host UI export names (host bridge may be unavailable):', err)
  }
}
