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
 * Renderer-side **host UI table**.
 *
 * Background: plugin bundles (`userData/plugins/<id>/renderer.mjs`) must not each bundle another
 * copy of React / antd / i18n — that would yield a second React instance (hooks crash outright), a
 * different antd theme context from the host, and i18n resources invisible to each other. Packaging
 * therefore rewrites plugin imports that point at host UI and third-party vendors to
 * `plugin://host/ui.js?m=<key>`, and the main process's protocol handler generates the ESM bridge
 * dynamically, with every export pointing at **the same instance here in the host**.
 *
 * Two key shapes (same as workshop build output):
 * - `@host/renderer/<path relative to src/renderer/src, no extension>`: a host UI module;
 * - `@host/vendor/<package name>`: the single vendor instance in the host.
 *
 * **Export names must be listed explicitly, never guessed via `Object.keys(module object)`**
 * (measured pitfall, 2026-09-26): the default export of `src/renderer/src/i18n/index.ts` is the
 * i18next instance, and `import * as ns` yields **that instance object**, not the module namespace
 * — `Object.keys(ns)` returns i18next's own properties (`t`/`use`/`init`…), and
 * `ns.useTranslation` is undefined. The bridge generates `export const X = m["X"]` from this list,
 * so a wrong list means plugins get undefined at runtime.
 * `assertHostUiShape()` checks the list at startup and names missing exports in the console (rather
 * than waiting for a plugin to go blank).
 *
 * Vendors (react/antd/icons) are genuine bundler namespaces, so `Object.keys` enumeration is
 * reliable: the host bundler produces them and their keys are the export names. The exception is
 * **dayjs**: it only has a default export (see the note in the table below), so it gets an
 * explicit list like host UI modules.
 */
export interface HostUiEntry {
  /** Module instance (what a plugin's import ultimately receives) */
  module: unknown
  /** Export names the plugin may import by name for this key (`default` need not be listed; the bridge adds it) */
  names: string[]
}

/** Vendor namespace: keys are the export names */
const vendor = (mod: unknown): HostUiEntry => ({
  module: mod,
  names:
    typeof mod === 'object' && mod !== null
      ? Object.keys(mod).filter((k) => k !== 'default' && !k.startsWith('_') && k !== '__esModule')
      : []
})

/** Host UI module: exports listed explicitly (see the comment above) */
const hostModule = (mod: unknown, names: string[]): HostUiEntry => ({ module: mod, names })

/**
 * Host UI / vendor table.
 *
 * `react/jsx-runtime` and `react` point at the same React (react-jsx-runtime's internal
 * `require('react')`), so the automatic JSX runtime for `<div/>` and `useState` never diverge.
 */
export const HOST_UI: Record<string, HostUiEntry> = {
  // ---------- Host UI modules ----------
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
    // ShinyText must provide both named and default: in the harness plugin it is
    // `import { ShinyText, ShinyIcon }`; with only default the bridge has no `ShinyText` binding
    // → undefined at runtime → JSX throws "Element type is invalid"
    // (test/verify-plugin-host-ui-exports.mjs guards exactly this case).
    { default: ShinyText, ShinyText, ShinyIcon },
    ['ShinyText', 'ShinyIcon']
  ),
  '@host/renderer/components/provider/provider-mark': hostModule({ default: ProviderMark }, []),

  // ---------- vendor (the single instances in the host) ----------
  '@host/vendor/react': vendor(React),
  '@host/vendor/react/jsx-runtime': vendor(ReactJsxRuntime),
  '@host/vendor/react-dom': vendor(ReactDom),
  '@host/vendor/react-dom/client': vendor(ReactDomClient),
  '@host/vendor/antd': vendor(antd),
  '@host/vendor/@remixicon/react': vendor(RemixIcons),
  '@host/vendor/@ant-design/icons': vendor(AntIcons),
  /**
   * dayjs only has a **default export** (a callable object with its static methods on it).
   *
   * `vendor(dayjs)` is deliberately not used here: `vendor()` enumerates named exports via
   * `Object.keys`, but dayjs is a function, so that yields an empty list (same result, fuzzier
   * semantics). Writing `hostModule({ default: dayjs }, [])` states explicitly that "plugins may
   * only `import dayjs from 'dayjs'`", and the bridge generates `export default m.default ?? m`.
   *
   * Why the bridge is required (measured in P2): the host's `@renderer/i18n` imports dayjs and sets
   * the locale globally; a plugin shipping its own copy would get a different Dayjs class, splitting
   * `isDayjs()`, antd DatePicker controlled values, and locale.
   */
  '@host/vendor/dayjs': hostModule({ default: dayjs }, [])
}

/** All module keys in the host UI table (the renderer loader uses them to decide which specifiers go through the bridge) */
export function hostUiKeys(): string[] {
  return Object.keys(HOST_UI)
}

/**
 * Host vendored instances (the table behind the legacy `ctx.require(name)` path).
 *
 * If a third-party plugin marks react/antd as external in its own build, it gets the host's
 * **single** instance from this table, preventing duplicate React / split antd contexts. Since P5
 * all four built-in plugins go through the `@host/vendor/<spec>` bridge (the same instances, see
 * the table above); this is kept for old-style third-party plugins that still use `ctx.require`
 * (compatibility path, no examples left in the repo).
 *
 * These point at the **same import** as `@host/vendor/*` in HOST_UI, so the two tables never yield
 * two Reacts.
 */
export const vendorModules: Record<string, unknown> = {
  react: React,
  antd,
  '@remixicon/react': RemixIcons
}

/**
 * Verify that the export names declared in the table really exist on the modules (early detection
 * for wrong lists).
 *
 * Warn only, never throw: a missing name at worst makes one plugin fail to load with a named error,
 * and should not take down host startup.
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
 * Install the table + report keys and export names to the main process (the protocol handler
 * generates the ESM bridge from them).
 */
export function installHostUi(): void {
  assertHostUiShape()
  ;(globalThis as typeof globalThis & { __RB_HOST_UI__?: Record<string, unknown> }).__RB_HOST_UI__ =
    Object.fromEntries(Object.entries(HOST_UI).map(([k, v]) => [k, v.module]))

  const names = Object.fromEntries(Object.entries(HOST_UI).map(([k, v]) => [k, v.names]))
  try {
    window.api.plugin.reportHostUi(names)
  } catch (err) {
    // Not thrown: the host UI table itself is already usable (the vendor bridge still works); only
    // the host bridge reports a readable error
    console.warn('[plugin-host] Failed to report host UI export names (host bridge may be unavailable):', err)
  }
}
