# 插件目录契约（src/plugins/<id>/）

> 目标：**每个功能（内容）是一个自包含插件**——它的界面、IPC、数据表、业务服务、词条都在同一个目录里，
> 而不是按「层」散落在 `src/main/ipc`、`src/main/database`、`src/main/harness`、`src/renderer/src/i18n` 等处。
> core 只保留外壳（窗口/托盘/主题/i18n 内核）、插件宿主、DB 引擎（PGlite + drizzle 迁移器）、
> 模型 Provider 与 preload 通用桥。

## 目录形态

```
src/plugins/<id>/
  manifest.ts            三端共用的清单（id/name/version/description/icon/routes/menu/inject/provide）
  main/
    index.ts             主进程入口：export install(ctx: MainPluginContext): void | (() => void)
    ipc.ts               本插件的 IPC 通道（交给 ctx.registerIpc）
    db/schema.ts         本插件的 drizzle 表（由 core 的 database/schema/index.ts 汇总，供迁移与查询）
    db/mapper.ts         本插件的行类型与查询（统一走 withOrm）
    services/**.ts       本插件的业务服务（可被本插件的 ipc 与别的插件经 provide/inject 使用）
  renderer/
    plugin.tsx           渲染层入口：export default { manifest, install(ctx) }
    api.ts               本插件主进程通道的薄封装（window.api.plugin.invoke + 类型）
    Index.tsx            路由页面（懒加载目标）
    components/**        本插件的组件
    hooks/** utils/**    本插件的前端逻辑
  shared/**.ts           主/渲染共用的类型（跨进程 DTO，不得 import react/electron）
  locales/index.ts       本插件词条：{ 'zh-CN': {...}, 'en-US': {...} }，renderer install 时注册
```

## 主进程契约（内置 = 外部，同一套）

```ts
import type { MainPluginContext } from '../../main/plugins/context'

export function install(ctx: MainPluginContext): void | (() => void) {
  ctx.registerIpc({
    'plugin:music:get-folders': async () => {
      /* ... */
    }
  })
  // 主进程 → 渲染层的事件通道（只 send、无 handler）：必须声明才进 preload 白名单
  ctx.registerEvent('plugin:music:play-track')
  ctx.effect(() => {
    const timer = setInterval(poll, 5000)
    return () => clearInterval(timer)
  })
}
```

- **通道命名空间**：`plugin:<命名空间>:<channel>`，命名空间 = 插件 id 去掉开头的 `plugin.` 段
  （`music` → `plugin:music:*`；外部插件 `plugin.demo` → `plugin:demo:*`）。宿主权威校验，
  重复占用报错。渲染层经 preload 通用桥 `window.api.plugin.invoke/on` 调用。
- **事件通道**：`ctx.registerEvent('plugin:<ns>:<channel>')` 声明只有发送方的通道
  （`webContents.send` 用）。preload 的白名单只收录插件**声明过**的通道；
  不声明时订阅不会抛错（preload 只打一条告警），但主进程侧没有任何发送方，
  事件永远不来——所以声明仍然是必须的。
  preload 启动时会用一次同步 IPC（`plugin-channels-sync`）把权威清单取回来，
  之后启停变化由 `pushPluginChannels()` 增量刷新——插件 Provider 在 useEffect 里的
  首个订阅因此不会因为「推送还没到」而刷出无意义的告警。
- **可逆装配**：`ctx.effect` 的效果按 LIFO 回滚；`install` 返回的 dispose 最先执行；
  IPC 通道随 `ctx.dispose()` 全部摘除。停用插件 = 卸载它的全部内容。
- 插件的主进程代码可以照常 `import` core 模块（`@main/database/orm`、settings、workspace 等）；
  **禁止**再把通道登记进 `src/main/ipc/index.ts`（那是旧路径，只留给尚未迁移的插件）。

## 渲染层契约

```tsx
import manifest from '../manifest'
import { installMusicRenderer } from './install'

export default {
  manifest,
  install(ctx) {
    ctx.use('route').register({ path: '/music', skeleton: 'music', load: () => import('./Index') })
    ctx
      .use('menu')
      .register({ key: 'music', labelKey: 'shell.menu.music', icon: <RiDiscLine />, order: 30 })
    ctx.use('settingsSection').register({ tabKey: 'music' /* ... */ })
    ctx.use('appProvider').register({ Provider: AudioProvider, order: 20 })
    ctx.use('bottomBar').register({
      id: 'music',
      order: 10,
      isVisible: () => Boolean(getCurrentTrack()),
      subscribe: subscribeCurrentTrack,
      Tab: MusicBottomTab,
      Popup: MusicMiniPlayer
    })
    ctx.use('i18n').addResources('translation', locales) // 词条随插件注册，停用即消失
  }
}
```

- 挂载点（宿主上下文键）：`route` / `menu` / `settingsSection` / `appProvider` / `globalComponent` /
  `bottomBar` / `api` / `i18n` / `events` / `storage`。**插件自己的 Provider 与状态也随插件注册**
  （例如音乐播放器的 `AudioProvider`），不得再放进 `App.tsx` 的 core Provider 层或让外壳组件直接 import。
- 外壳组件只认注册表：`MainRoutes` / `CustomFrame` / `BottomBar` / `SettingsModal` / `AppContent`。
  如果某个外壳组件需要插件的数据（例：底栏的音乐条目），就给它加一个**插槽**，让插件来填。
- **`bottomBar` 插槽**（参考实现）：注册项是 `{ id, order, isVisible(), subscribe?, Tab, Popup }`。
  宿主在每次渲染时读 `isVisible()` 决定该项是否参与轮播，插件用 `subscribe(onChange)` 通知
  宿主重渲染；`Tab` 是底栏那一行，`Popup` 是悬停弹层。插件状态放模块级可订阅快照里
  （见 `src/plugins/music/renderer/audio/store.ts`），外壳因此完全不 import 插件模块。

## 装配入口（P5 起只剩清单注册表）

| 位置                         | 内容                                                                        |
|----------------------------|---------------------------------------------------------------------------|
| `src/plugins/manifests.ts` | **唯一**的清单注册表：只 import 各插件的 `manifest.ts`（无 react/electron 依赖），供主进程铺包/面板列举 |

P1~P4 期间 core 还持有两张**静态注册表**（`src/main/plugins/builtin.ts` 的主模块登记、
`src/renderer/src/plugin-host/builtin.ts` 的渲染模块登记）与一张过渡白名单
（`src/main/plugins/packaged.ts`）。P5 已全部删除：四个内置插件与第三方插件走**完全相同**的
磁盘包链路（`resources/plugins/<id>/` → 首次启动铺到 `userData/plugins/<id>/` → 装载），
应用里不再有任何插件实现的应用内 import（`node test/verify-plugin-restructure.mjs` 断言）。
方案与分轮验收见 `PACKAGING.md`。

## 结构与契约入口

内置插件（`notes` / `harness`）与独立插件（`task-planner` / `music-player`，源码在
`github.com/Aitenry/ryten-plugins`）都已自包含在各自的
`src/plugins/<id>/{manifest,main,renderer,shared,locales}` 或插件仓库的 `plugins/<id>/**`，**迁移全部完成**。
core 只剩「外壳 + 插件宿主 + DB 引擎 + 模型 Provider + 通用 preload 桥」。

看代码时的入口（按需要选一处，不要从别处猜）：

| 想了解                                     | 看这里                                                                    |
|-----------------------------------------|------------------------------------------------------------------------|
| 目录形态、主进程/渲染层契约、通道命名规则                   | 本文档上面几节                                                                |
| 主进程插件上下文（registerIpc/effect/contribute） | `src/main/plugins/context.ts`                                          |
| 多值贡献点（AI 工具、宿主生命周期钩子）                   | `src/main/plugins/contributions.ts`、`app-hooks.ts`                     |
| 主进程应用事件总线（core → 插件推送时机）                | `src/main/plugins/app-events.ts`                                       |
| 宿主装载/卸载与 preload 白名单推送                  | `src/main/plugins/host.ts`                                             |
| 插件清单唯一定义                                | `src/plugins/manifests.ts`                                             |
| 各插件的通道名                                 | `src/plugins/<id>/main/ipc/**`、渲染层的 `src/plugins/<id>/renderer/api.ts` |
| **用对话让助手做插件（工坊：构建/自动验收/发布）**             | `src/plugins/harness/main/workshop/README.md`                          |
| 迁移历史、踩过的坑、跨插件耦合清单                       | `src/plugins/MIGRATION.md`、`test/plugin-coupling-notes.md`             |

core 的边界（本轮收尾后）：

- `src/main/**` 不 import 任何插件模块，**唯一例外**是 `src/main/database/schema/index.ts`
  的 schema re-export（drizzle-kit 不解析 tsconfig paths，单一 schema 入口是既有约定）；
  渲染层同样零插件 import（`src/renderer/src/i18n/i18next.d.ts` 只做**类型**汇聚）；
- core 不认识任何插件通道名（`plugin:notes:graph-build-*` 已随 `BuildProgressProvider`
  整体收进 notes 插件）；
- **插件的唯一来源就是磁盘包**：`resources/plugins/<id>/`（随应用分发）→ 首次启动铺到
  `userData/plugins/<id>/` → 与第三方插件同一条装载链路；`pnpm dev` 下若产物缺失或落后于源码，
  `installer.ts` 会自动用 `scripts/build-plugins.mjs --dev` 补打（见 `PACKAGING.md`）；
- 插件参与宿主时机的唯一方式是贡献点 + 事件订阅，贡献随 `ctx.dispose()` 摘除
  ⇒ **停用插件即不再执行它的任何钩子**。
