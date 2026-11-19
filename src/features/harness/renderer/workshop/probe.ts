import { harnessApi } from '../api'

/**
 * 渲染层**实时探针**：在真实渲染进程里把一个插件的渲染模块 import + install 一遍。
 *
 * 为什么必须是真渲染进程（而不是主进程里做静态分析）：外部插件最常见的失败是
 * **装载期就炸**——引了宿主 UI 表里没有的键、顶层读了不存在的全局、桥的具名导出对不上、
 * 注册的组件一渲染就抛 `Element type is invalid`。这些只有在真 React、真 antd、
 * 真 `__RB_HOST_UI__` 表的环境里跑一遍才会暴露。
 *
 * 与真实装载的两点差别（刻意的）：
 * 1. **上下文是记录版**：注册项进数组而不是宿主注册表，探针因此**不改变界面**
 *    （真装一遍再卸掉会让用户的菜单闪一下）；
 * 2. **跑完就走回滚**：install 之后把所有 effect 逆序回滚，顺手验证「插件可停用」。
 *
 * 说明符改写用的是**活表** `globalThis.__RB_HOST_UI__`（宿主 `external-loader.ts` 用的是
 * 主进程桥自报的键表，两者同源）。这里不直接复用宿主 loader 是有意的：那个模块不在宿主 UI
 * 桥的公开表里，而探针是诊断工具——它自己的改写规则坏掉时表现为「探针失败」，
 * 不影响真实装载路径。
 *
 * 前置条件：插件必须**已安装且启用**（`plugin://<id>/…` 才拿得到文件、才不是 403），
 * 因此主进程只在「发布之后」或「已安装插件的复验」时发探针。
 */

/** 需要改写成宿主桥 URL 的说明符判定（与宿主 loader 的 needsBridge 同规则） */
function bridgeKey(spec: string, hostTable: Record<string, unknown>): string | null {
  if (spec.startsWith('@host/')) return spec
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return null // data:/blob:/plugin://…
  const vendorKey = `@host/vendor/${spec}`
  return vendorKey in hostTable ? vendorKey : null
}

/**
 * 把产物里的宿主说明符改写成 `plugin://host/ui.js?m=<key>`。
 *
 * blob 模块没有裸说明符的解析能力（那正是宿主 loader 存在的原因），
 * 因此这里做同一件事：只动宿主表里**真的有的**键，其余原样保留。
 */
function rewriteHostSpecifiers(source: string, hostTable: Record<string, unknown>): string {
  const re = /(\bfrom\s*|\bimport\s*\(\s*|(?:^|[;}\n])\s*import\s*)(['"])([^'"]+)\2/gm
  return source.replace(re, (whole, prefix: string, quote: string, spec: string) => {
    const key = bridgeKey(spec, hostTable)
    return key ? `${prefix}${quote}plugin://host/ui.js?m=${encodeURIComponent(key)}${quote}` : whole
  })
}

/** 记录版宿主上下文（渲染层契约见 src/renderer/src/plugin-host/context.ts） */
function createRecordingContext(): {
  ctx: Record<string, unknown>
  registrations: string[]
  /** 注册项里声明的文案键（跑完检查「译得出来吗」——命名空间写错时菜单会显示原始键名） */
  labelKeys: string[]
  rollback: () => void
} {
  const registrations: string[] = []
  const labelKeys: string[] = []
  const undos: Array<() => void> = []
  const routes: { path: string; load?: () => Promise<unknown> }[] = []
  /** 宿主真实的 i18n 实例（在下面 i18n.addResources 里把插件词条真的注册进去） */
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
       * 词条真的注册进宿主 i18n（不是记一笔了事）：这样探针才能核对
       * 「注册项里的 labelKey 到底译不译得出来」——把语言当命名空间写
       * （`addResources('zh-CN', …)`）的插件，菜单里会显示原始键名，
       * 这是外部插件最常见也最难自查的一类错（2026-09-27 真机实测踩到）。
       */
      addResources: (ns: string, resources: Record<string, Record<string, unknown>>) => {
        registrations.push(`i18n:${ns}`)
        if (!hostI18n || typeof resources !== 'object' || resources === null) return
        for (const lang of Object.keys(resources)) {
          try {
            hostI18n.addResourceBundle(lang, ns, resources[lang], true, true)
          } catch {
            // 词条注册失败不该让探针崩：下面用 exists 检查自会点名
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
    /** 探针内部用：把注册的路由交出来（挂载冒烟要靠它） */
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
          // 回滚失败不阻断其余（与宿主 dispose 一致）
        }
      }
    }
  }
}

/** 注册项里的文案键是否都能译出来（译不出来 = 词条没注册对，界面会显示原始键名） */
function unresolvedLabels(labelKeys: string[]): string[] {
  const i18n = (
    globalThis as {
      __RB_HOST_UI__?: Record<string, { i18n?: { exists: (key: string) => boolean } }>
    }
  ).__RB_HOST_UI__?.['@host/renderer/i18n']?.i18n
  if (!i18n || typeof i18n.exists !== 'function') return []
  return [...new Set(labelKeys)].filter((key) => !i18n.exists(key))
}

/** 取模块导出里的 install（兼容 default / default.install / install 三种形态） */
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

/** 等一小会儿（懒加载 chunk 与 effect 里的微任务都能跑完） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 挂载冒烟：把第一个注册路由的组件真的渲染一次（catch 渲染期崩溃）。
 *
 * 用宿主那一份 React 与 react-dom/client（`__RB_HOST_UI__` 里的就是宿主实例），
 * 因此不会出现「插件自带第二份 React」的假象。渲染到游离节点上，跑完立刻 unmount。
 * 渲染期抛错由 React 19 交回 `window.onerror`，这里靠临时错误监听捕捉。
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
      // 卸载失败不影响结论
    }
    container.remove()
  }
}

/** 跑一次探针并把结果回话给主进程（任何异常都收敛成 fail，不抛给调用方） */
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
            // 文案键译不出来 = 词条注册没写对（界面会显示 x.menu.title 这种原始键名）
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
    console.warn('[workshop] 探针结果回话失败:', err)
  }
}
