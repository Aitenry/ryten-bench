# 内容插件化迁移清单（逐插件执行）

> 契约见 `src/plugins/README.md`；进度用 `node test/audit-plugin-layout.mjs` 量（退出码 = 未完成项数）。
> 迁移策略：**一次一个插件，绿测后提交**，任何时刻仓库都可运行。
> 顺序：music（参考实现）→ planner → home → harness（最大）。
>
> **改名记录（2026-09-26）**：`home` 已改名为 `notes`（目录 / id / 路由 `/notes` / 菜单键 /
> 词条命名空间 `notes.*` / 通道 `plugin:notes:*`；**菜单图标不动**，仍是 `RiDashboardLine`）。
> 本文与 `PACKAGING.md` 里的 `home`
> 均指今天的 `notes`，历史记录按当时的名字保留。表名与 AI 工具名一律未变。
> 另外 `music` / `planner` 已移出应用，成为独立插件 `music-player` / `task-planner`
> （源码与发布在 `Aitenry/ryten-plugins`）。

## 现状盘点（2026-09-26 迁移前实测）

主进程共 153 个 ts 文件，其中 **104 个（68%）属于这四个插件**，却全部散在
`src/main/ipc`、`src/main/database/{schema,mapper}`、`src/main/harness`、`src/main/graph`、`src/main/workspace`。
IPC 通道共 126 个，全部是扁平名（`music-get-folders`、`harness-stream-chunk`…），没有任何命名空间。
preload 976 行单文件里装着全部插件的 API 命名空间。渲染层 17 个词条文件与壳文案混放。

| 插件      | 主进程旧位置（文件 / 行）                                                                                                      | 通道前缀（个数）                                 | preload 键                                                        | core 里残留的渲染层内容                                                                                      |
|---------|---------------------------------------------------------------------------------------------------------------------|------------------------------------------|------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| music   | `ipc/music.ts`、`database/{schema,mapper}/music.ts`（3 / 882）                                                         | `music`（15）                              | `music`                                                          | `contexts/AudioContext.tsx`、`types/music.ts`、`i18n/locales/*/music{,Settings}.ts`、`BottomBar` 的音乐条目 |
| planner | `ipc/planner.ts`、`database/{schema,mapper}/planner.ts`（3 / 445）                                                     | `planner`（10）                            | `planner`                                                        | `types/planner.ts`                                                                                  |
| home    | `ipc/{todo,document,wiki,node-position,graph}.ts`、`database/{schema,mapper}/*`、`graph/**`（28 / 5692）                | `todo, task, doc, wiki, graph, node`（50） | `todoItems, taskDependencies, docs, wikis, graph, nodePositions` | `components/{graph,wiki,todo}/**`、首页词条                                                              |
| harness | `ipc/{harness,harness-topic,mnemon}.ts`、`harness/**`(55)、`workspace/**`(4)、`database/{schema,mapper}/*`（70 / 17370） | `harness, mnemon, agent, main`（41）       | `harness, mnemon, agents, mainAgent`                             | `types/harness.ts`、harness 词条                                                                       |

## 每个插件的固定动作

1. **主进程**：`main/index.ts` 导出 `install(ctx)`，把原 `ipcMain.handle('x-y', …)` 收成
   `ctx.registerIpc({ 'plugin:<ns>:x-y': … })`；表与查询搬到 `main/db/{schema,mapper}.ts`；
   服务搬到 `main/services/**`；从 `src/main/ipc/index.ts` 的 `builtinIpcGroups` 删除该组。
   （P1~P4 期间还要在 `src/main/plugins/builtin.ts` 静态登记主模块，并配一份渲染层的
   `plugin-host/builtin.ts` 登记；**P5 起这两张表连同过渡白名单 `packaged.ts` 都已删除**——
   插件只从 `resources/plugins/<id>/` 的磁盘包装载，`pnpm build:plugins` 出产物。）
2. **通道命名**：`<prefix>-<rest>` → `plugin:<ns>:<rest>`；主进程 → 渲染层的事件通道同样改名，
   并确认 `pushPluginChannels()` 会把它们推给 preload（内置插件的 `on` 订阅也走白名单）。
3. **preload**：删除该插件的命名空间；类型声明同步删除（`src/preload/index.d.ts`、
   `src/renderer/resource/types/window.d.ts`）。渲染层改用插件自己的 `renderer/api.ts`（通用桥 + 类型）。
4. **渲染层**：`renderer/**` 收进插件目录；**插件自己的 Provider/状态随插件注册**
   （`ctx.use('appProvider')`），外壳组件不得 import 插件模块——需要数据就给外壳加插槽
   （参照 music 的 `bottomBar` 挂载点）。
5. **词条**：`locales/{zh-CN,en-US}.ts` + `locales/index.ts`，在 renderer install 里
   `ctx.use('i18n').addResources('translation', locales)`；从中央 locales 的 index 摘掉。
6. **单一真源**：`manifest.ts` 只写一份，主进程目录（`src/plugins/manifests.ts`）与渲染层
   `plugin.tsx` 都 import 它。
7. **验证与提交**：`pnpm run typecheck` → `node test/audit-plugin-layout.mjs`（该插件项归零）→
   6 个离线工装 → `node test/verify-plugin-host.mjs`（真实 Electron + CDP）→ 英文 conventional commit。

## 已知陷阱（踩过的）

- **drizzle**：插件 schema 由 core 的 `database/schema/index.ts` 用**相对路径** re-export，
  并把插件 schema 文件加进 `drizzle.config.ts` 的 `schema`（drizzle-kit 不解析 tsconfig paths）；
  迁移照旧 `pnpm drizzle-kit generate`，历史迁移文件不能动。
- **构建**：`@plugins` 别名在 main / renderer 两边都要指到 `src/plugins`；`tsconfig.node.json`
  要 include `src/plugins/**`，`tsconfig.web.json` 要 include + paths。
- **Tailwind v4**：`src/renderer/src/assets/main.css` 只有 `@import 'tailwindcss'`，自动扫描基于
  Vite root。渲染层文件搬到 `src/plugins/**`（root 之外）后**必须实测**被搬走的组件里的工具类
  是否仍出现在产物 CSS 里，缺了就补 `@source '../../../plugins/**/*.{ts,tsx}'`。
- **Vite dev**：`server.fs.allow` 需允许仓库根下的 `src/plugins`（dev 下 import root 之外的文件）。
- **跨插件依赖**（不许偷偷 import 别的插件的实现）：
  - `src/main/harness/tools/*.ts` 里 planner/home/music 的工具已**搬进各插件**（
    `src/plugins/<id>/main/tools.ts`），harness 只留「工具注册表 + `harness.tool` 贡献点」
    （见 test/plugin-coupling-notes.md §5）；跨插件直读只剩 harness 自己的表（`mapper/agent`）。
  - `src/main/ipc/provider.ts` 里混着 `agent-*`/`main-*` 通道（属于 harness 的智能体配置）→
    迁移 harness 时一起搬走，provider.ts 只留模型 Provider。
  - 渲染层 `components/markdown/**`、`hooks/useMessage`、`utils/formatTime` 等被多个插件共用 →
    留在 core（共享 UI/工具），但**不得**反向 import 任何插件。
- **preload 白名单**：白名单推送早于窗口创建会丢包，已用 `did-finish-load` 补推（`pushPluginChannels`）；
  新增插件通道后不需要额外配置，但内置插件的**事件**订阅也受白名单门控，测试要覆盖。
- **graph 曾常驻 core 组**：`BuildProgressProvider` 是无条件挂载的外壳 Provider，图谱通道搬进 home 后
  停用 home 会失去事件来源 → 订阅必须 try/catch 降级为空闲（否则异常从 useEffect 逃逸会卸载 Provider、整树白屏）；
  另外 `graph-build-start` 原本是 `ipcMain.on`（fire-and-forget），新契约只有 `handle`，改成 invoke 后
  渲染层调用点要 await 才能捕获 rejection。
- **审计口径**：`node test/audit-plugin-layout.mjs` 的「旧路径残留」指标会过滤 `src/plugins/` 命中——
  它衡量的是「还没搬走的旧位置」，插件自己新写的 `main/db/mapper/...` 不该计入。
- **插件渲染层在模块顶层读通用桥**：`renderer/api.ts` 里 `const invoke = window.api.plugin.invoke`
  是模块顶层求值（与 home/planner/music 一致）——jsdom / SSR 工装一旦 import 到任何插件组件就必须
  **先**给 `window.api.plugin` 打桩（`test/lib/plugin-bridge.mjs`），否则整批工装会以
  `Cannot read properties of undefined (reading 'plugin')` 挂掉。
- **插件词条不再进中央表**：工装直接加载 `@renderer/i18n` 时不会走插件 install，
  得显式注册（`test/lib/harness-locales.mjs` / 各 bundle 入口），否则界面渲染成裸键、按文案断言全失准。

## 迁移进度（每轮更新，权威版本在 `src/plugins/README.md` 的勾选表）

| 步骤          | 提交        | 内容                                                                                                                                                                                                                                                                                                                      |
|-------------|-----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 宿主 + 注册表    | `9cf1c55` | 渲染层 plugin-host、注册表、外部插件机制、设置面板                                                                                                                                                                                                                                                                                         |
| 主进程契约       | `104b51d` | `MainPluginContext`（registerIpc/registerEvent/effect）、命名空间独占、单一路径装载                                                                                                                                                                                                                                                     |
| music       | `c673c4e` | 19 通道 → `plugin:music:*`；AudioProvider 随插件；新增通用 `bottomBar` 插槽；preload 删 `api.music`                                                                                                                                                                                                                                    |
| planner     | `449faa0` | 10 通道 → `plugin:planner:*`；DTO 进 shared；`plannerApi` 取代 `api.planner`                                                                                                                                                                                                                                                   |
| home 主进程    | `bfc65b8` | 50 通道 → `plugin:home:*`；表/mapper/图谱服务进 main/**；graph 移出 core 组 + 降级防线                                                                                                                                                                                                                                                   |
| home 渲染层    | `c7fd004` | 视图/组件/props/词条进插件；preload 六命名空间收口（855→665 行）；GraphView 仍独立懒加载 chunk                                                                                                                                                                                                                                                     |
| AI 工具归属     | `ed77eaf` | 工具实现进归属插件（planner/home/music），harness 只做注册表；新增 `ctx.contribute/contributions` + `harness.tool` 契约                                                                                                                                                                                                                       |
| harness 主进程 | 本轮        | 65 文件搬进 `src/plugins/harness/main/**`（runtime/service/tools/workspace/db）；45 通道 → `plugin:harness:*`（9 个 `workspace-*` 移出 core 组）；15 事件通道 `ctx.registerEvent`；启动接线（快照目录+工作区监听）进 `install` 的 `ctx.effect`；`agent-*`/`main-agent-*` 从 provider.ts 归位                                                                      |
| harness 渲染层 | 本轮        | 58 文件收进 `src/plugins/harness/renderer/**`；`types/harness.ts` 拆进 shared（DTO）/renderer（纯前端）；4 个词条文件进 `locales/**` 随插件注册；preload 五命名空间（harness/agents/mainAgent/mnemon/workspace）删除并改走 `harnessApi`；doc-changed 反向耦合解耦到宿主事件总线                                                                                              |
| core 收尾     | 本轮        | 删 `builtinIpcGroups`/`CORE_IPC_GROUP`/`ipc-capture`/`builtin-catalog`（改 `registerCoreIpc()` + `initPluginHost()`）；6 处过渡 import 全部改成贡献点/事件订阅（新增 `plugins/app-hooks.ts` + `plugins/app-events.ts`）；`BuildProgressProvider` 整体收进 home 插件（core 不再认识 `plugin:home:graph-build-*`）；`AppContent.currentKey` 改为路由派生；清死类型并更新契约文档 |

> 进度口径：`node test/audit-plugin-layout.mjs` 已是 **0 未完成项**（退出码 0），
> 四个内置插件与 core 收尾全部完成。

## core 收尾轮（最后一轮）的落地要点

1. **宿主生命周期钩子 = 贡献点**（不为每处造机制）：
  - `src/main/plugins/app-hooks.ts`：`APP_PRELOAD` / `APP_BEFORE_QUIT` / `APP_RENDERER_MEMORY_DUMP`
    三个多值贡献点 + `APP_EVENT_WORKSPACE_CHANGED` 事件名；
  - `src/main/plugins/app-events.ts`：主进程事件总线（`onAppEvent` / `emitAppEvent`，同步派发、异常吞掉）；
  - 6 处过渡 import 的去向：加载页预取→`APP_PRELOAD`；渲染内存快照→`APP_RENDERER_MEMORY_DUMP`；
    Mnemon 退出清理→`APP_BEFORE_QUIT`；工具结果目录→harness `install` 的 `ctx.effect`
    （停用时 `configureToolOutputStore('')` 降级）；工作区切换→`APP_EVENT_WORKSPACE_CHANGED`；
    唯一保留的 core→插件依赖是 `database/schema/index.ts` 的 schema re-export（drizzle 约定）。
2. **停用即不再执行**：贡献随 `ctx.dispose()` 摘除、事件订阅随 `ctx.effect` 回滚，
   由 `verify-plugin-host.mjs` 的 `app-lifecycle-hooks` 只读探针实测（停用 harness 后三个钩子为 0、
   工作区订阅为 0，重新启用后回归）。
3. **core 不再认识插件通道名**：`BuildProgressProvider` / `BuildProgressContext` /
   `useBuildProgress` / `BuildProgressState` 一并搬进 `src/plugins/home/renderer/providers/**`，
   由 home 的 `plugin.tsx` 经 `ctx.use('appProvider')` 注册，订阅自己的通道；
   通知中心仍是 core 服务，`NotificationItem` 收敛为通用结构（插件扩展字段按名读取）。
4. **外壳局部状态外置**：`AppContent.currentKey` 改为 `useLocation().pathname` 派生，
   菜单点击不再写 state——启停注册了 `appProvider` 的插件（外壳子树重挂）后高亮不再错位。

## AI 工具注册契约（用户 2026-09-26 要求；实施细节见 `test/plugin-coupling-notes.md` §5）

工具**实现**属于数据归属方插件，harness 只拥有注册表。宿主提供多值贡献点：

```ts
// 供给方（planner / home / music 的 main/index.ts install 内）
ctx.contribute(HARNESS_TOOL_CONTRIBUTION, { name, info, build })

// 消费方（harness）
listContributions<PluginToolContribution>(HARNESS_TOOL_CONTRIBUTION)
```

- 拉取语义 ⇒ **顺序无关**：harness 每次组装工具集时才读贡献，谁先装载都能拿到。
- 插件停用 ⇒ 贡献随 `ctx.dispose()` 移除 ⇒ 下一次组装模型就看不到该工具（有 CDP 断言覆盖）。
- 契约类型（`PluginToolContribution`、`ToolInfo`、`HARNESS_TOOL_CONTRIBUTION`）放 `src/main/plugins/tool-contract.ts`，
  插件**不得** import harness 的任何东西。
