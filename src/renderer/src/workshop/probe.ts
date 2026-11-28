import { harnessApi } from '../api/harness'

/**
 * Renderer **live probe**: imports and installs a plugin's render module for real inside the
 * actual renderer process.
 *
 * Why it must be the real renderer process (and not static analysis in the main process): the
 * most common failure of external plugins is **exploding at load time** — referencing a key that
 * is missing from the host UI table, reading a non-existent global at the top level, named
 * exports of the bridge not matching, or a registered component throwing `Element type is
 * invalid` on first render. These only surface when the code runs in an environment with real
 * React, real antd and a real `__RB_HOST_UI__` table.
 *
 * Two deliberate differences from a real install:
 * 1. **The context is a recording one**: registrations go into arrays instead of the host
 *    registry, so the probe **does not change the UI** (installing and uninstalling for real
 *    would make the user's menu flicker);
 * 2. **Roll back as soon as it finishes**: after install, all effects are rolled back in reverse
 *    order, which also verifies that the plugin can be disabled.
 *
 * Specifier rewriting uses the **live table** `globalThis.__RB_HOST_UI__` (the host
 * `external-loader.ts` uses the key table reported by the main-process bridge; both share the
 * same source). Not reusing the host loader directly is intentional: that module is not in the
 * public host UI bridge table, and the probe is a diagnostic tool — when its own rewriting rules
 * break, the symptom is "the probe failed" and the real load path is unaffected.
 *
 * Precondition: the plugin must be **installed and enabled** (only then can `plugin://<id>/…`
 * fetch the file, and only then is it not a 403), so the main process only sends a probe after
 * publishing or when re-verifying an installed plugin.
 */

/** Specifiers that must be rewritten to the host bridge URL (same rule as the host loader's needsBridge) */
function bridgeKey(spec: string, hostTable: Record<string, unknown>): string | null {
  if (spec.startsWith('@host/')) return spec
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return null // data:/blob:/plugin://…
  const vendorKey = `@host/vendor/${spec}`
  return vendorKey in hostTable ? vendorKey : null
}

/**
 * Rewrite host specifiers in the build output to `plugin://host/ui.js?m=<key>`.
 *
 * Blob modules cannot resolve bare specifiers (which is exactly why the host loader exists), so
 * this does the same thing here: only keys that **really exist** in the host table are touched,
 * everything else is left as is.
 */
function rewriteHostSpecifiers(source: string, hostTable: Record<string, unknown>): string {
  const re = /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])([^'"]+)\2/gm
  return source.replace(re, (whole, prefix: string, quote: string, spec: string) => {
    const key = bridgeKey(spec, hostTable)
    return key ? `${prefix}${quote}plugin://host/ui.js?m=${encodeURIComponent(key)}${quote}` : whole
  })
}

/** Recording host context (renderer contract in src/renderer/src/plugin-host/context.ts) */
function createRecordingContext(): {
  ctx: Record<string, unknown>
  registrations: string[]
  /** Label keys declared by registrations (checked afterwards: "do they resolve?" — a wrong namespace makes the menu show raw key names) */
  labelKeys: string[]
  rollback: () => void
} {
  const registrations: string[] = []
  const labelKeys: string[] = []
  const undos: Array<() => void> = []
  const routes: { path: string; load?: () => Promise<unknown> }[] = []
  /** The host's real i18n instance (plugin resources are actually registered into it below in i18n.addResources) */
  const hostI18n = (
    globalThis as {
      __RB_HOST_UI__?: Record<string, { i18n?: { addResourceBundle: (...a: unknown[]) => void } }>
    }
  ).__RB_HOST_UI__?.['@host/renderer/i18n']?.i18n

  const services: Record<string, unknown> = {
    route: {
      register: (route: { path?: string; load?: () => Promise<unknown> }) => {
        registrations.push(`route:${route?.path ?? '?'}`)
        if (route?.path) routes.push({ path: route.path, load: route.load })
      }
    },
    menu: {
      register: (item: { key?: string; labelKey?: string }) => {
        registrations.push(`menu:${item?.key ?? '?'}`)
        if (typeof item?.labelKey === 'string') labelKeys.push(item.labelKey)
      }
    },
    settingsSection: {
      register: (section: { tabKey?: string; labelKey?: string }) => {
        registrations.push(`settingsSection:${section?.tabKey ?? '?'}`)
        if (typeof section?.labelKey === 'string') labelKeys.push(section.labelKey)
      }
    },
    appProvider: {
      register: (provider: { order?: number }) =>
        registrations.push(`appProvider:${provider?.order ?? '-'}`)
    },
    globalComponent: {
      register: (item: { id?: string }) => registrations.push(`globalComponent:${item?.id ?? '?'}`)
    },
    bottomBar: {
      register: (item: { id?: string }) => registrations.push(`bottomBar:${item?.id ?? '?'}`)
    },
    i18n: {
      /**
       * Resources are really registered into the host i18n (not merely noted down): that way the
       * probe can verify whether "the labelKeys in registrations actually resolve" — plugins that
       * pass the language as the namespace (`addResources('zh-CN', …)`) show raw key names in the
       * menu, which is the most common and hardest-to-self-check error in external plugins (hit
       * on a real device on 2026-09-27).
       */
      addResources: (ns: string, resources: Record<string, Record<string, unknown>>) => {
        registrations.push(`i18n:${ns}`)
        if (!hostI18n || typeof resources !== 'object' || resources === null) return
        for (const lang of Object.keys(resources)) {
          try {
            hostI18n.addResourceBundle(lang, ns, resources[lang], true, true)
          } catch {
            // A failed resource registration must not crash the probe: the exists check below will name it
          }
        }
      }
    },
    events: { emit: () => undefined, on: () => () => undefined },
    storage: { get: () => undefined, set: () => undefined, remove: () => undefined },
    api: { invoke: () => Promise.resolve(undefined), on: () => () => undefined }
  }

  const ctx = {
    use: (key: string) => services[key] ?? { register: () => undefined },
    get: (key: string) => services[key],
    set: () => undefined,
    effect: (register: () => void | (() => void)) => {
      registrations.push('effect')
      const undo = register()
      if (typeof undo === 'function') undos.push(undo)
    },
    require: (name: string) =>
      (globalThis as { __RB_HOST_UI__?: Record<string, unknown> }).__RB_HOST_UI__?.[
        `@host/vendor/${name}`
      ],
    /** Probe-internal: expose the registered routes (the mount smoke test needs them) */
    __routes: routes
  }

  return {
    ctx,
    registrations,
    labelKeys,
    rollback: () => {
      while (undos.length > 0) {
        try {
          undos.pop()?.()
        } catch {
          // A failed rollback doesn't block the rest (consistent with host dispose)
        }
      }
    }
  }
}

/** Whether all label keys of registrations resolve (unresolved = resources registered wrong; the UI would show raw key names) */
function unresolvedLabels(labelKeys: string[]): string[] {
  const i18n = (
    globalThis as {
      __RB_HOST_UI__?: Record<string, { i18n?: { exists: (key: string) => boolean } }>
    }
  ).__RB_HOST_UI__?.['@host/renderer/i18n']?.i18n
  if (!i18n || typeof i18n.exists !== 'function') return []
  return [...new Set(labelKeys)].filter((key) => !i18n.exists(key))
}

/** Pick install from the module exports (accepts the three shapes default / default.install / install) */
function pickInstall(mod: unknown): ((ctx: unknown) => unknown) | null {
  const namespace = mod as { default?: unknown; install?: unknown }
  const candidates = [
    namespace?.default,
    (namespace?.default as { install?: unknown } | undefined)?.install,
    namespace?.install
  ]
  const found = candidates.find((item) => typeof item === 'function')
  return (found as ((ctx: unknown) => unknown) | undefined) ?? null
}

/** Wait a little (lazy chunks and microtasks in effects can finish) */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mount smoke test: actually render the component of the first registered route once (catches
 * crashes during render).
 *
 * Uses the host's own React and react-dom/client (the instances inside `__RB_HOST_UI__`), so
 * there is no illusion of "the plugin bringing a second copy of React". Renders into a detached
 * node and unmounts immediately afterwards. Render-time errors are handed back to
 * `window.onerror` by React 19 and are captured here by a temporary error listener.
 */
async function mountSmoke(ctx: Record<string, unknown>): Promise<string | null> {
  const hostTable = (globalThis as { __RB_HOST_UI__?: Record<string, unknown> }).__RB_HOST_UI__
  const routes =
    (ctx.__routes as { path: string; load?: () => Promise<unknown> }[] | undefined) ?? []
  const first = routes.find((route) => typeof route.load === 'function')
  if (!first?.load) return null

  const React = hostTable?.['@host/vendor/react'] as
    { createElement: (type: unknown, props?: unknown) => unknown } | undefined
  const client = hostTable?.['@host/vendor/react-dom/client'] as
    | { createRoot: (node: Element) => { render: (node: unknown) => void; unmount: () => void } }
    | undefined
  if (!React || !client) return null

  const mod = (await first.load()) as { default?: unknown }
  const Component = mod?.default
  if (typeof Component !== 'function' && typeof Component !== 'object') {
    return `路由 ${first.path} 的懒加载模块没有导出组件（load() 应返回 { default: Component }）`
  }

  const container = document.createElement('div')
  container.style.display = 'none'
  document.body.appendChild(container)
  const errors: string[] = []
  const onError = (event: ErrorEvent): void => {
    errors.push(event.message)
  }
  window.addEventListener('error', onError)
  const root = client.createRoot(container)
  try {
    root.render(React.createElement(Component, null))
    await sleep(80)
    return errors.length > 0 ? `渲染期报错：${errors[0]}` : null
  } catch (err) {
    return `渲染失败：${(err as Error).message}`
  } finally {
    window.removeEventListener('error', onError)
    try {
      root.unmount()
    } catch {
      // A failed unmount doesn't affect the conclusion
    }
    container.remove()
  }
}

/** Run the probe once and report the result back to the main process (any exception collapses to fail, never thrown to the caller) */
export async function handleProbeRequest(payload: {
  probeId: string
  id: string
  entry: string
}): Promise<void> {
  const startedAt = Date.now()
  const registrations: string[] = []
  let status: 'pass' | 'fail' | 'skip' = 'pass'
  let detail: string | undefined
  let rollback: (() => void) | null = null

  try {
    const hostTable = (globalThis as { __RB_HOST_UI__?: Record<string, unknown> }).__RB_HOST_UI__
    if (!hostTable) {
      status = 'skip'
      detail = '宿主 UI 表未安装（installHostUi 未执行），跳过探针'
    } else {
      const response = await fetch(`plugin://${payload.id}/${payload.entry}`)
      if (!response.ok) {
        status = 'skip'
        detail =
          response.status === 403
            ? '插件当前处于停用状态：探针只能验已启用的插件（先发布/启用再复验）'
            : `入口取不到：HTTP ${response.status}（插件可能还没安装，探针在发布后自动复验）`
      } else {
        const source = rewriteHostSpecifiers(await response.text(), hostTable)
        const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        try {
          const mod = (await import(/* @vite-ignore */ blobUrl)) as unknown
          const install = pickInstall(mod)
          if (!install) {
            status = 'fail'
            detail = '渲染入口没有导出 install(ctx)（default 或具名 install）'
          } else {
            const recorder = createRecordingContext()
            rollback = recorder.rollback
            await install(recorder.ctx)
            registrations.push(...recorder.registrations)
            // Unresolved label keys = resources registered wrong (the UI would show raw keys like x.menu.title)
            const unresolved = unresolvedLabels(recorder.labelKeys)
            if (unresolved.length > 0) {
              status = 'fail'
              detail =
                `注册项里的文案键译不出来：${unresolved.join('、')}。` +
                `多半是 ctx.use('i18n').addResources 的第一个参数写成了语言——` +
                `它应该是命名空间 'translation'，语言放在第二个参数的键上。`
            } else {
              const mountError = await mountSmoke(recorder.ctx)
              if (mountError) {
                status = 'fail'
                detail = mountError
              }
            }
          }
        } finally {
          URL.revokeObjectURL(blobUrl)
        }
      }
    }
  } catch (err) {
    status = 'fail'
    detail = `探针异常：${(err as Error).message}`
  } finally {
    rollback?.()
  }

  try {
    await harnessApi.workshop.reportProbe({
      probeId: payload.probeId,
      status,
      detail,
      registrations,
      durationMs: Date.now() - startedAt
    })
  } catch (err) {
    console.warn('[workshop] Failed to report probe result:', err)
  }
}
