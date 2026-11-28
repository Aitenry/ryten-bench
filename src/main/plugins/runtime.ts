import { createRequire } from 'module'
import { app } from 'electron'
import logger from 'electron-log'

import * as context from '../context'
import * as aiChatModel from '../ai/chat-model'
import * as aiGraph from '../ai/graph'
import * as aiMessages from '../ai/messages'
import * as aiOutputParsers from '../ai/output-parsers'
import * as aiTools from '../ai/tools'
import * as databaseInstance from '../database/instance'
import * as databaseOrm from '../database/orm'
import * as databaseSchema from '../database/schema'
import * as databaseSchemaCommon from '../database/schema/common'
import * as databaseSchemaWorkspace from '../database/schema/workspace'
import * as databaseWorkspaceContext from '../database/workspace-context'
import * as mapperProvider from '../database/mapper/provider'
import * as i18n from '../i18n'
import * as toolResultsAgent from '../i18n/tool-results-agent'
import * as toolResultsDocs from '../i18n/tool-results-docs'
import * as toolResultsFs from '../i18n/tool-results-fs'
import * as toolResultsTodos from '../i18n/tool-results-todos'
import * as appEvents from '../plugins/app-events'
import * as appHooks from '../plugins/app-hooks'
import * as contributions from '../plugins/contributions'
import * as toolContract from '../plugins/tool-contract'
import * as providerCache from '../provider/cache'
import * as providerService from '../provider/service'
import * as safeSend from '../safe-send'
import * as weatherUtils from '../shared/weather-utils'
import * as sharedModelParams from '../../shared/model-params'
import * as sharedPluginCssSafety from '../../shared/plugin/css-safety'
import * as sharedPluginMenuIcons from '../../shared/plugin/menu-icons'

/**
 * Main-process **host runtime**.
 *
 * Background: plugin packages (`userData/plugins/<id>/main.cjs`) cannot each bundle their own copy
 * of core - that would give a second PGlite connection, a second electron-store instance, and
 * diverging i18n state. So at packaging time the plugin source's imports pointing at core are
 * rewritten to `@host/main/<relative path>`, and at runtime they are swapped here for **the module
 * instances the host itself already loaded** (which keeps the singletons).
 *
 * Handoff: `globalThis.__RB_HOST_RESOLVE__(spec)`. It must be mounted **before any plugin main.cjs
 * is required** (the first thing `initPluginHost()` does), otherwise plugin packages get undefined
 * at load time.
 *
 * Resolution semantics (highest priority first):
 *  1. `node:*` built-in modules -> require directly;
 *  2. hit the table below (`@host/main/**`, `@host/shared/**`) -> return the host's own module
 *     instance (singleton);
 *  3. other bare modules (electron / electron-log / zod/v4 / drizzle-orm/pg-core / music-metadata…)
 *     -> require with **the host's own resolution base**, returning the same instance the host
 *     already loaded;
 *  4. not found -> throw a readable error (with the spec and "the host runtime does not provide
 *     it").
 *
 * Key detail: the resolution base in step 3 must be the **app root**, not the plugin directory.
 * Plugins are installed under `userData/plugins/<id>/`, where there is no node_modules, so using
 * the plugin directory as the base would fail to resolve; using the app root both finds the
 * node_modules distributed with the app and hits Node's module cache, so the semantics "the same
 * instance the host already loaded" hold automatically.
 *
 * The table is **filled in on demand**: P1 got the music path working end to end while filling in
 * the static dependencies of planner/notes/harness at once. P2 (planner) uses 5 of the
 * `@host/main/**` keys, P3 (notes) 9, P4 (harness) 18 + `@host/shared/model-params` - in other
 * words the table is essentially saturated; the remaining external dependencies (`zod/v3|v4`,
 * `drizzle-orm`, `electron`, `electron-log`, `jsdom`, `mammoth`, `turndown`,
 * `@electric-sql/pglite`, `openmeteo`…) go through the bare-module resolution below; legacy
 * `@langchain/**` in old plugins is covered by the HOST_LEGACY compatibility layer (see below).
 * All 20 main-process contract modules are now in the table.
 */

/** Table key = the spec in the bundle (`@host/main/<path relative to src/main, no extension>`) */
const HOST_MAIN: Record<string, unknown> = {
  '@host/main/context': context,
  // Self-developed AI layer: plugins building tools / messages / graph orchestration use the
  // host's implementation
  '@host/main/ai/chat-model': aiChatModel,
  '@host/main/ai/graph': aiGraph,
  '@host/main/ai/messages': aiMessages,
  '@host/main/ai/output-parsers': aiOutputParsers,
  '@host/main/ai/tools': aiTools,
  '@host/main/database/instance': databaseInstance,
  '@host/main/database/orm': databaseOrm,
  '@host/main/database/schema': databaseSchema,
  '@host/main/database/schema/common': databaseSchemaCommon,
  '@host/main/database/schema/workspace': databaseSchemaWorkspace,
  '@host/main/database/workspace-context': databaseWorkspaceContext,
  '@host/main/database/mapper/provider': mapperProvider,
  '@host/main/i18n': i18n,
  '@host/main/i18n/tool-results-agent': toolResultsAgent,
  '@host/main/i18n/tool-results-docs': toolResultsDocs,
  '@host/main/i18n/tool-results-fs': toolResultsFs,
  '@host/main/i18n/tool-results-todos': toolResultsTodos,
  '@host/main/plugins/app-events': appEvents,
  '@host/main/plugins/app-hooks': appHooks,
  '@host/main/plugins/contributions': contributions,
  '@host/main/plugins/tool-contract': toolContract,
  // Plugin workshop (the harness's "build plugins conversationally") needs to read/write the
  // plugin directory and load/unload plugins: it borrows **the host's own** install/enable/
  // uninstall functions rather than creating another set (see workshop/wiring.ts). These keys are
  // always lazily loaded: they import back to plugins/host.ts, and host.ts imports this file again
  // (see lazyHostModule).
  /* eslint-disable @typescript-eslint/no-require-imports -- lazy loading: see the comment on lazyHostModule */
  '@host/main/plugins/host': lazyHostModule(() => require('../plugins/host')),
  '@host/main/plugins/host-ui-bridge': lazyHostModule(() => require('../plugins/host-ui-bridge')),
  '@host/main/plugins/lifecycle': lazyHostModule(() => require('../plugins/lifecycle')),
  '@host/main/plugins/package-install': lazyHostModule(() => require('../plugins/package-install')),
  '@host/main/plugins/scanner': lazyHostModule(() => require('../plugins/scanner')),
  '@host/main/plugins/store': lazyHostModule(() => require('../plugins/store')),
  '@host/main/ipc/plugins': lazyHostModule(() => require('../ipc/plugins')),
  /* eslint-enable @typescript-eslint/no-require-imports */
  '@host/main/plugins/runtime': { hostRuntimeKeys, installHostRuntime, resolveHostModule },
  '@host/main/provider/cache': providerCache,
  '@host/main/provider/service': providerService,
  '@host/main/safe-send': safeSend,
  '@host/main/shared/weather-utils': weatherUtils
}

/** `@host/shared/**` -> `src/shared/**` (pure modules shared by all three sides; plugins import @shared/* directly) */
const HOST_SHARED: Record<string, unknown> = {
  '@host/shared/model-params': sharedModelParams,
  // Shared by the plugin workshop and the plugin host: plugin.css host protection, declarative
  // menu icon allowlist
  // (the workshop build externalizes every `src/shared/**` import as `@host/shared/**`)
  '@host/shared/plugin/css-safety': sharedPluginCssSafety,
  '@host/shared/plugin/menu-icons': sharedPluginMenuIcons
}

/**
 * Legacy plugin **compatibility layer**: historical plugin packages import `@langchain/*` directly
 * as host dependencies.
 *
 * Those npm packages have been removed from the project (replaced by the self-developed
 * `src/main/ai/**`), but published plugins should not break because of it: the runtime table maps
 * the old specifiers to the self-developed implementations (the four contracts - messages / tools
 * / graph / parsers - keep the same shape). New plugins should import `@host/main/ai/tools` etc.
 * directly.
 */
const HOST_LEGACY: Record<string, unknown> = {
  '@langchain/core/tools': aiTools,
  '@langchain/core/messages': aiMessages,
  '@langchain/core/language_models/chat_models': aiChatModel,
  '@langchain/core/output_parsers': aiOutputParsers,
  '@langchain/langgraph': aiGraph
}

/** Host resolution base: app root (dev = repository root, packaged = app.asar root), with the process working directory as fallback */
function hostRequire(): NodeRequire {
  const base = app.isReady() ? app.getAppPath() : process.cwd()
  return createRequire(base.endsWith('package.json') ? base : base + '/package.json')
}

/**
 * **Lazily loaded** host module (required for the plugin workshop keys; reasons below).
 *
 * `plugins/host.ts` imports this file itself (for `installHostRuntime`), and the workshop's
 * `@host/main/plugins/host`, `lifecycle`, `package-install` etc. (directly or indirectly) all
 * import back to `host.ts` - a static import would form a **cycle**: under the CJS bundle the side
 * evaluated first receives a half-built namespace where "functions are not mounted yet", and at
 * plugin runtime it shows up as `xxx is not a function` (measured on a real machine on 2026-09-27:
 * creating a draft in the workshop failed outright). Requiring lazily on first access keeps the
 * cycle only in the definition phase, not in the evaluation phase.
 */
function lazyHostModule<T extends object>(load: () => T): T {
  let cached: T | null = null
  const resolve = (): T => (cached ??= load())
  return new Proxy({} as T, {
    get: (_target, key) => Reflect.get(resolve(), key),
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    /**
     * The descriptor **must report configurable: true**: the proxy target is an empty object, and
     * properties such as `__esModule` on a real ESM namespace are non-configurable - copying the
     * descriptor would violate the Proxy invariant, and esbuild's `__toESM` (the interop layer for
     * `import * as` in plugin packages) would throw
     * `'getOwnPropertyDescriptor' on proxy: trap reported non-configurability for property …`
     * (measured on a real machine on 2026-09-27: the whole harness main module failed to load
     * because of it, and the UI showed no channels at all).
     */
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    }
  })
}

/** Cached host require (the base may differ before and after app ready; fixed on first use) */
let cachedRequire: NodeRequire | null = null

function resolveBare(spec: string): unknown {
  cachedRequire ??= hostRequire()
  return cachedRequire(spec)
}

/**
 * Get a host module by spec. `require(...)` in plugin packages is rewritten by the bundler into
 * calls to this function, so it **never returns undefined**: if it cannot be resolved, it throws,
 * exposing "the host does not provide it" at load time instead of turning into a downstream
 * `Cannot read properties of undefined`.
 */
export function resolveHostModule(spec: string): unknown {
  if (typeof spec !== 'string' || spec === '') {
    throw new Error('宿主运行时解析失败：模块说明符为空')
  }
  if (spec.startsWith('node:')) return resolveBare(spec)

  if (Object.prototype.hasOwnProperty.call(HOST_MAIN, spec)) return HOST_MAIN[spec]
  if (Object.prototype.hasOwnProperty.call(HOST_SHARED, spec)) return HOST_SHARED[spec]
  if (Object.prototype.hasOwnProperty.call(HOST_LEGACY, spec)) return HOST_LEGACY[spec]

  try {
    return resolveBare(spec)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const count =
      Object.keys(HOST_MAIN).length +
      Object.keys(HOST_SHARED).length +
      Object.keys(HOST_LEGACY).length
    // Readable error: state who, why, and where to look next (the table is filled in on demand)
    throw new Error(
      `宿主运行时没有提供模块 '${spec}'：它既不在宿主运行时表（${count} 个 @host/** 契约模块）里，` +
        `也无法从应用根 '${app.isReady() ? app.getAppPath() : process.cwd()}' 解析到。` +
        `若这是插件新引入的 core 依赖，请在 src/main/plugins/runtime.ts 的表里补上；原始错误：${detail}`
    )
  }
}

/**
 * Mount the host runtime (idempotent).
 *
 * It must be called in `initPluginHost()`, **before scanning/loading any external plugin**: as soon
 * as a plugin main.cjs is required it executes `require('@host/main/...')` from its source, and
 * those calls ultimately land on this global function.
 */
export function installHostRuntime(): void {
  const target = globalThis as typeof globalThis & {
    __RB_HOST_RESOLVE__?: (spec: string) => unknown
  }
  target.__RB_HOST_RESOLVE__ = resolveHostModule
  logger.info(
    `[Plugins] Host runtime mounted (@host/main ${Object.keys(HOST_MAIN).length} modules + @host/shared ${Object.keys(HOST_SHARED).length} modules)`
  )
}

/** Keys in the runtime table (for diagnostics: the panel/tooling can verify which host modules a plugin package references) */
export function hostRuntimeKeys(): string[] {
  return [...Object.keys(HOST_MAIN), ...Object.keys(HOST_SHARED), ...Object.keys(HOST_LEGACY)]
}
