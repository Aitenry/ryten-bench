# 插件打包与物理卸载（方案 B，2026-09-26 用户选定）

> 用户要求：「内置的插件，可以完全卸载的形式，不是直接用开关形式」。
> 卸载口径（用户澄清两轮后定稿）：**卸载 = 移除插件代码；「同时删除该插件的全部数据」是一个勾选项**
> （不勾 = 数据留在库里，重装后仍可用）。
>
> 本文是分轮实施的方案书。P1~P5 已完成（见文末表格）。

## 独立插件仓库（P5 之后，2026-09-26 用户选定）

planner 与音乐**不再随应用分发**：它们搬到了独立仓库
[`Aitenry/ryten-plugins`](https://github.com/Aitenry/ryten-plugins)（公开），当作第三方插件安装。

```
插件仓库                                   应用侧
plugins/<id>/manifest.ts …（源码）         设置 → 插件 →「从插件仓库安装」
  │  CI：node scripts/build.mjs --tag v…      │  读 <repo>/plugins.json（索引，含 sha256）
  ▼                                            │  下载 <repo>/releases/download/<tag>/<id>-<v>.zip
dist/<id>/{plugin.json,main.cjs,             │  校验 sha256 → 解压 → 校验 plugin.json
           renderer.mjs,chunk-*.mjs}          ▼  装进 userData/plugins/<id>/ → 启用并装载
dist/<id>-<version>.zip  →  GitHub Release
plugins.json（索引，提交回 main）
```

- **安装实现**：`src/main/plugins/github.ts`（索引 → 下载 → sha256 → 解压（拒绝目录穿越/子目录）→ 安装/升级）。
  地址可用 `RB_PLUGINS_REPO` 覆盖（离线工装用插件仓库自带的 fixture 服务器指向本机 HTTP）。
- **URL 规则单独锁住**：索引/资产地址由纯函数 `src/shared/plugin/index-url.ts` 生成，
  `node --experimental-strip-types test/verify-plugin-asset-url.mjs` 逐分支断言（18 条）——
  重点是「索引里没有 tag 时走 `releases/latest/download/<asset>`」而不是 404 的
  `releases/download/latest/<asset>`。fixture 只覆盖「索引与资产同源」那条分支
  （`verify-github-plugin-install` 19 条），其余分支由这份离线断言兜住。
- **索引可能比 Release 晚几分钟**：`raw.githubusercontent.com` 的 CDN 会缓存索引。
  2026-09-26 实测：CI 发完 v0.1.1、资产已可下载，应用读到的索引仍是 `tag=v0.1.0` 约 1~2 分钟；
  试过在 URL 上加 `?t=<随机>` 做 cache-buster，**仍然吃到 `x-cache: HIT` 的旧内容**（加了没用，
  反而多一次未命中），所以最终保持干净 URL、把这条写进文档：面板的「刷新」会重新读，
  但同样受 CDN 限制；发布后立刻验证时先确认索引里的 `tag` 已经是新版本。
- **仓库已发布并实测（2026-09-26）**：`Aitenry/ryten-plugins` 已建（public，MIT，README 英文），
  推 tag `v0.1.0` 后 CI 成功（run #1，约 30s）——Release 里两个 zip 的 `digest` 与 CI 提交回 `main`
  的 `plugins.json`（`tag: v0.1.0`）里的 `size`/`sha256` **逐字节一致**。
  真机链路由新增的在线工装 `test/verify-plugin-github-live.mjs` 实测（10 条断言全绿）：
  应用默认索引地址（`raw.githubusercontent.com`）0.3~1.1s 读回 `tag=v0.1.0`；`installFromGithub('music-player')`
  真实下载 Release 资产（22KB，资产主机在本地网络上时快时慢：1.4s / 20.4s）+ sha256 校验通过 → 装进
  `userData/plugins/music-player` → 菜单/通道/自带 DDL 建出 `music_folders` 全部可用 → 卸载含 purge 清干净。
  ⚠️ 同一台机器上 PowerShell 的 `Invoke-WebRequest` 打 `raw.githubusercontent.com` 会 6/6 超时而 Electron 的
  `net.fetch` 正常——**判据以应用自身为准**，不要用 PowerShell 的连通性否定这条链路。
- **构建不可字节复现**：zip 内嵌条目时间戳，同源码两次构建**大小相同、sha256 不同**，因此索引必须与
  上传的资产出自同一次构建（CI 就是这么做的；本地 `npm run build` 改写 `plugins.json` 后**不要提交**，
  除非发布的正是那批本地 zip）。插件仓库的 fixture 服务器已改为**按本机 dist 现算** `size`/`sha256`
  并去掉 `tag`，所以本地跑离线工装与仓库里那份 CI 索引可以并存。
- **命名**：独立插件的目录名与 id 一致（`task-planner` / `music-player`），IPC 命名空间随之成为
  `plugin:task-planner:*` / `plugin:music-player:*`；**数据库表名不变**（`planner_tasks` / `music_folders`），
  所以老用户的数据在「内置 → 独立」这次搬家前后是同一批行。
- **表结构归插件**：core 的 `database/schema` 与 `drizzle.config.ts` 不再包含这两组表，插件装载时
  用自带 DDL（`main/db/ddl.ts`）幂等建表；mapper / purge 都先 `await schemaReady`。
  老库（表已存在）→ `IF NOT EXISTS` 全部命中；新库 → 由插件建表。
  ⚠️ drizzle 迁移 `0007` 的 `DROP TABLE` 是**手工删掉的**（见该文件注释）：照原样执行会删光用户数据。
- **升级清理**：`plugins.json.seeded` 记录「本应用铺过哪些 id」，`installer.removeRetiredBundledPlugins()`
  据此删掉 `planner` / `music` 的旧铺包（它们在新宿主上装载必然失败），**不碰数据、不碰用户自装的插件**。
- **第三方插件不再借用宿主命名空间**：菜单文案 / 设置页签文案由插件自己的词条提供
  （`planner.menu.title` / `music.menu.title` / `musicSettings.nav`），宿主不再为它们保留
  `shell.menu.*` / `settings.nav.*` 条目。

## 目标形态

```
应用包内（随应用分发，只读）        首次启动安装到（可读写、可删除）
resources/plugins/<id>/      ──▶   userData/plugins/<id>/
  plugin.json                        plugin.json
  main.cjs                           main.cjs
  renderer.mjs / chunk-*.mjs         renderer.mjs / chunk-*.mjs
```

- **运行时不再有「内置插件」**：应用里没有对插件代码的静态 import，所有插件都从
  `userData/plugins/<id>/` 按同一条外部插件链路加载（`loadExternalMain` + `plugin://` 渲染模块）。
- 「内置」只表示**随应用分发、可随时重装**（现在只有 `notes` / `harness`）；「第三方」是用户装的
  （含从插件仓库安装的 `task-planner` / `music-player`）。二者在列表里区分，卸载行为一致
  （删目录），区别是内置的可以从应用包重新安装。
- 插件的数据**不在插件目录里**（表在 core 的 schema、行在同一个 PGlite 库），所以「卸载」与「清数据」是两件事，
  分开询问（见下）。

## 宿主运行时契约（方案的核心约束）

插件包必须**通过宿主拿 core 与宿主 UI 的能力**，否则会打出第二份 PGlite 连接 / React / i18n。
做法：打包时把指向 core（`../../main/**`）与宿主 UI（`@renderer/**`）的导入改写成 `@host/**` 外部依赖，
运行期由宿主注入同一份模块实例。

- **应用内的内置插件**（`notes` / `harness`）：源码照常写相对路径，构建时自动改写，**源码一行不用改**
  （仍按真实 core 类型做 typecheck）。
- **独立仓库里的插件**（`task-planner` / `music-player`）：源码直接写 `@host/main/**`、`@host/renderer/**`
  （仓库里没有 core 源码可指），宿主 API 的类型由仓库自己的 `host.d.ts` 声明。

打包后统计出的接口面（去重，2026-09-26 实测；契约以 `src/main/plugins/runtime.ts` 与
`src/renderer/src/plugin-host/host-ui.ts` 的表为准，`node test/audit-plugin-host-contract.mjs` 会核对）：

**主进程 21 个**：`@host/main/` 下的 `context`（settingsStore）、
`database/{instance,orm,schema,schema/common,schema/workspace,workspace-context}`、
`database/mapper/provider`、`i18n`、`i18n/tool-results-{agent,docs,fs,todos}`、
`plugins/{app-events,app-hooks,contributions,tool-contract}`、
`provider/{cache,service}`、`safe-send`、`shared/weather-utils`，外加 `@host/shared/model-params`。

⚠️ **独立插件不从这里取表**：`task-planner` / `music-player` 的表由插件自己建（自带 DDL），
宿主的 schema 里没有它们——插件只借用宿主的 `images` 等共享表。

**渲染层 15 个**：`@host/renderer/` 下的 `i18n`、`hooks/{useMessage,useNotification,useTheme}`、
`components/markdown/{MarkdownView,MarkdownLoad,TipTapMarkdownEditor}`、
`components/system/{Skeleton,settings/SettingsUI}`、
`components/{effects/ShinyText,provider/provider-mark}`、`route/RouteSkeleton`、
`utils/{document,formatTime,providerMeta}`。

**渲染层 vendor 8 个**：`@host/vendor/` 下的 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
`antd`、`@remixicon/react`、`@ant-design/icons`、`dayjs`（宿主里已有唯一实例的第三方；`vendor()` 用 `Object.keys`
枚举命名导出，dayjs 只有默认导出因此显式写名单）。P2 实测：未把 dayjs 放进 vendor 时 planner 的渲染产物里
带了一份独立的 dayjs（41.3KB → 走桥后 33.2KB），`isDayjs()` 与 antd DatePicker 的受控值会跨实例分裂。

### 主进程交接方式

宿主在加载任何插件前挂上运行时表（实际实现见 `src/main/plugins/runtime.ts`）：

```js
// 打包时插件里的 core/裸模块导入被改写成一句 require 垫片，最终落到这个全局函数：
globalThis.__RB_HOST_RESOLVE__(spec) // '@host/main/database/orm' → 宿主那一份实例（单例保住）
// 其它裸模块（electron / langchain / zod / drizzle…）
// → 按宿主自身的解析路径（应用根）require 同一实例
```

### 渲染层交接方式

渲染层插件包是 ESM（`plugin://` + blob import 加载），宿主 UI 以 **ESM 桥**提供：
`plugin://host/ui.js`（由协议处理器生成，内容是 `const H = globalThis.__RB_HOST_UI__; export const X = H.X;` 形式的具名导出）。
需要：

- CSP 的 `script-src` 加上 `plugin:`（现在是 `'self' blob:`）；
- 宿主的 `__RB_HOST_UI__` 表在渲染层启动时挂上（15 个模块 + 8 个 vendor，静态 import 后聚合）；
- 桥按 `?m=<键>` 逐个生成（键 = 打包产物里的说明符），导出名由渲染层一次性上报
  （`plugin-host-ui-exports`）——主进程因此仍然不认识任何宿主模块。

### `plugin://` 的状态码契约（2026-09-26 修）

判定全在**零依赖纯函数** `src/main/plugins/protocol-routing.ts` 里（`protocol.ts` 只负责
「按判定取文件 / 生成桥 ESM」），因此可以脱离 Electron 用
`node --experimental-strip-types test/verify-plugin-protocol-404.mjs` 直接跑真实代码。契约：

| 情况                               | 状态码     |
|----------------------------------|---------|
| URL 非法 / 非 `plugin:` / 桥缺 `?m=`  | 400     |
| 插件未安装 / 桥路径不是 `ui.js`            | 404     |
| 插件已停用（早于文件判定，不泄露文件是否存在）          | 403     |
| 路径归一化后跑出插件目录（`%2e%2e%2f` 这类编码穿越） | 403     |
| **文件不存在**（含「路径是目录」）              | **404** |
| 真实读取故障                           | 500     |

**为什么缺失文件必须是 404**：`net.fetch('file:///…')` 取不到文件时是**抛异常**
（`Error: net::ERR_FILE_NOT_FOUND`），不是返回 404 响应——于是缺失文件会掉进 catch 被当成
「读取失败 500 + warn」。内置插件包的 `plugin.css` 本来就不随包分发（类名由宿主构建期
Tailwind 扫 `src/plugins/**` 编译进宿主 CSS），结果是**每次启用插件都在主日志里留一条带堆栈的
假报错**，同时消费方的 `res.ok` 判断永远走不到。修成 404 后：可选资源缺失走「静默跳过」
（主进程只记 debug），真实故障才留 warn。

### 渲染层多文件产物（P3 落地）

渲染入口仍是**一个** `renderer.mjs`，但它不再是一个巨型单文件：插件自己的动态 import
（`lazy(() => import('./graph/GraphView'))`、codemirror 语言包…）会拆成 `chunk-<hash>.mjs`。

- 打包：`splitting: true` + `chunkNames: 'chunk-[hash]'` + `outExtension: { '.js': '.mjs' }`；
  不开 splitting 时 esbuild 会把动态 import **内联进入口**——P3 实测 home 的 `renderer.mjs`
  因此从 118.0KB 涨到 1310KB（把 ~1MB 的 echarts 带进首页首屏）。
- 为什么相对说明符必须绝对化：入口是 `fetch` 下来再以 **blob URL** import 的，blob 模块
  没有可解析的相对基准（`./chunk-x.mjs` → `blob:…/chunk-x.mjs`）。打包脚本因此把产物里
  「确实指向本次产物」的相对说明符改写成 `plugin://<id>/<文件>`。
- 铺包时按**模式**识别产物（`plugin.json` / `main.cjs` / `renderer.mjs` / `chunk-*.mjs`），
  升级时顺手清掉旧哈希的 chunk。
- chunk 只有真正 mount 时才取（P3 工装用 CDP Network 域实测：首屏只取入口 + 入口静态共享的
  那个 chunk，打开图谱才取 `chunk-IZPBTTMD.mjs`，即 echarts 那一个）。

### 插件自带的样式表 `plugin.css`（2026-09-26 用户实测「外部插件界面变形」后补的）

**症状与根因**：宿主自己的 Tailwind 是**构建期**扫源码生成的（`main.css` 里 `@source src/plugins/**`），
只覆盖随应用分发的内置插件；运行期才装进 `userData/plugins/<id>/` 的外部插件源码不在扫描范围里。
实测 task-planner / music-player 用到的 124 个类名里有 **48 个在宿主产物 CSS 里没有任何规则**
（`w-[280px]` / `grid-cols-2` / `bottom-full` / `hover:scale-105` / `overflow-x-hidden`…），
布局因此塌掉——用户看到的就是「样式和以前不一样、内容都变形了」。

**约定**：

- 插件包里可以带一份 `plugin.css`（插件仓库的 `scripts/build.mjs` 用 Tailwind 扫**插件自己的**源码
  编译：只取 `theme` + `utilities` 两层，**不含 preflight**——注入到宿主文档里的 base 层会重置宿主样式；
  编译时加 `source(none)`，否则 Tailwind 会自动扫整个仓库，两份插件的 CSS 会变成同一份全集）；
- 宿主装载插件时 `fetch('plugin://<id>/plugin.css')` 并注入 `<head><style data-plugin-css="<id>">`，
  停用/卸载时摘除（`src/renderer/src/plugin-host/plugin-css.ts`，在 `host.enable/disable` 里调用）；
- 包里没有这个文件时**静默跳过**（只留一条 debug 日志），旧包与纯 JS 样式的插件照常可用——
  内置插件本来就属于这一类（它们没有 `plugin.css`，靠宿主构建期扫描出类名），
  所以这条路径必须依赖「协议处理器把缺失文件如实回 404」，见上一节的状态码契约；
- 用内联 `<style>` 而不是 `<link rel="stylesheet" href="plugin://…">`：CSP 里只有
  `style-src 'self' 'unsafe-inline'`，没有 `style-src plugin:`。

**升级必须重新装载**（同轮踩到的第二个坑）：主进程换了磁盘上的包（仓库升级 / 本地升级 /
面板菜单里的「重新安装」）后，渲染层原先只看「这个 id 是否已登记」→ 直接跳过重载，
用户升完级看到的还是旧界面、也没有新样式。现在 `PluginListEntry` 多了一个 `stamp`
（入口文件与 `plugin.css` 的 mtime 最大值，见 `ipc/plugins.ts` 的 `packageStamp`），
渲染层（`App.tsx` 的 `PluginStateBridge`）在 stamp 或版本变化时先 `forgetPlugin` 再重新
`fetch + install`，于是新 `renderer.mjs` 与新 `plugin.css` 一起生效。

**回归**：`node test/verify-plugin-protocol-404.mjs`（离线：直接加载零依赖的路由纯函数，
断言缺失文件 404 / 目录 404 / 停用 403 / 编码穿越 403 / 桥缺 `?m=` 400，
以及处理器源码里缺失分支只记 debug）；`node test/probe-plugin-css-coverage.mjs`
（离线：逐个类名找规则，宿主 CSS 缺 48 个 → 加上插件自带 CSS 后 0 个缺；并核对 zip 里带上
`plugin.css`、无 preflight、两份 CSS 不是同一份）；`node test/probe-external-plugin-ui.mjs`
（装机：装「去掉 plugin.css 的包」→ 无注入、缺规则、截图；换成真包 → 注入 9804B/2986B、
规则齐、重新截图；两张截图逐像素比对 **music 3.9%** 的采样点发生变化；停用摘样式 / 启用重新注入）。

## 安装 / 卸载 / 清数据

- **首次启动（内置插件）**：把 `resources/plugins/<id>/`（现在只有 `notes` / `harness`）copy 到
  `userData/plugins/<id>/`；`plugins.json` 的 `uninstalled` 列表里的插件**跳过**（用户卸载过就不自动装回来）。
- **安装（重装内置插件）**：从 `resources/plugins/<id>/` 重新 copy，并清掉 `uninstalled` 记录。
- **自动更新（内置插件，2026-09-26 用户口径「内置的插件并没有检测更新，每次进去都得手动到设置页点更新」）**：
  启动时、铺包与装载之前（`ensureBundledPluginsInstalled()`），对每个已安装的内置插件比一次
  **应用包副本 vs 已安装副本的内容指纹**（`src/main/plugins/package-digest.ts`：文件集 → 字节数 → 逐文件 sha1），
  不一致就静默覆盖产物并在主日志留一行
  `[Plugins] <id> 已安装副本与应用包不一致（changed: renderer.mjs）→ 自动更新`（末尾一条 `内置插件自动更新完成：…` 汇总）。
  - **为什么不能只看版本号**：`plugins.json.seeded[id]` 记的是**应用版本**，dev 下恒为 `0.1.0`——
    重打了插件产物也不会触发（用户遇到的正是这个：改一版插件就得去设置页点一次「更新」）；
    同版本重发、副本被写坏、旧版残留 `chunk-*.mjs` 同理，版本号都不动。
  - 版本号不同的情形（应用升级）仍先用 `seeded` 判据直接重铺，不白花一次内容比对。
  - 判定「一致」时**什么都不做**：不重写任何产物文件（mtime 不变，避免每次启动都 churn 一遍）。
    实测两个内置插件共 3447KB 产物，「一致」判定（含逐文件 sha1）合计 **14.4ms**；
    文件集/字节数不符时走纯 `stat` 路径（0.4~1.8ms），根本不读内容。
  - 用户主动卸载过的（`uninstalled`）照旧不装回来；第三方插件不参与这条路径
    （它们的更新来源是插件仓库，仍由面板「⋯ → 更新」触发）。
  - 回归：`node --experimental-strip-types test/verify-bundled-plugin-drift.mjs`
    （离线 29 条：一致 / 缺产物 / 残留 chunk / **同长度改写（证明必须读盘算哈希，不能只看大小）** /
    边界与「应用包里没有」/ 非产物文件忽略 / 真实产物上的正反例与耗时实测 / 源码守卫）；
    `node test/probe-builtin-plugin-autoupdate.mjs`
    （端到端 22 条，4 个阶段：空 userData 首铺并逐字节一致 → 破坏已安装副本（同长度改 `renderer.mjs`
    + 删一个 chunk + 塞一个残留 chunk）→ 重启后**无人点过任何按钮**即逐字节恢复、残留 chunk 被清掉、
      菜单照常且渲染包真的能装载 → 再重启一次产物 mtime 全不变（无 churn）→ 改**应用包**那份（模拟重打包）
      → 重启跟着更新）。
- **安装（独立插件）**：设置 → 插件 →「从插件仓库安装」→ 读索引、下载 zip、校验 sha256、解压装进
  `userData/plugins/<id>/`，随后自动启用并装载（见上文「独立插件仓库」）。
- **安装（本地：压缩包 / 文件夹，2026-09-26 新增）**：设置 → 插件 →「从本地安装」（**一个**入口）。
  - 为什么只有一个按钮：Windows / Linux 的系统选择框**不能同时**是文件选择器与目录选择器
    （Electron 文档明说：两个属性同时给时只显示目录选择器），所以单个对话框只能表达一种形态。
    这里用**一个文件对话框 + 两个筛选器**同时覆盖两种来源：
    `.zip` 压缩包 → 解压安装；进到插件文件夹里选它的 `plugin.json` → 装那个目录
    （对话框标题与筛选器名字把这件事写清楚，安装时按 `dirname` 取父目录）。
  - 压缩包解压允许子目录与「右键压缩整个文件夹」多出来的那层顶层目录（自动剥掉），
    **拒绝**绝对路径与 `..` 目录穿越，噪音条目（`__MACOSX` / `.DS_Store` / `Thumbs.db`）忽略；
  - 文件夹必须是插件**构建产物**目录（含 `plugin.json`，例如插件仓库里的 `dist/<id>`）；
    选它的上一级且里面只有一个包时自动下钻，有多个包则报错要求选其中一个；
  - 两种来源与「从插件仓库安装」共用同一个落地内核 `src/main/plugins/package-install.ts`：
    同一套校验（字段齐备 / 拒绝 `builtin:true` / 拒绝覆盖内置 id / 入口文件必须存在）、
    同一套升级清理（旧版本多出来的文件删掉）、同样装完即启用并装载；
  - 装的是**拷贝**，不是就地启用：卸载删的永远是 `userData/plugins/<id>/`，不会碰到你选的目录；
  - 选择框本身没法被自动化点击，所以工装走「按显式路径安装」的 IPC（`plugins-install-local`，
    上面的三种路径形态它都接受），面板按钮走 `plugins-pick-local`（取消返回
    `{ ok: true, canceled: true }`，不算失败）。覆盖见 `test/verify-plugin-local-install.mjs`
    （25 条：zip / 前缀形态 / 升级清理 / 目录 / plugin.json / 9 类错误路径 / 入口与按钮唯一性 /
    卸载含 purge）。
- **面板行内操作收进「⋯」菜单（2026-09-26 用户要求）**：一列「卸载」文字按钮 + 一个开关太吵，
  现在每行右侧只有一个「⋯」，菜单三档：**更新 / 重新安装**（同名动作：用来源里的那份代码覆盖当前安装）、
  **启用 / 禁用**（原开关）、**卸载**（危险色，仍弹「代码与数据分开」的确认框）。
  - 更新来源：内置插件看**应用包里的同名副本**版本（`PluginListEntry.bundledVersion`，主进程随列表下发），
    第三方插件看**插件仓库索引**版本（面板静默拉一次 `plugin.available()`，失败就当作没有更新来源，
    不阻断列表；主进程侧索引有 60s 缓存）。没有来源（本地自己装的、又不在仓库里）→ 菜单不显示该项。
  - 菜单项文案照实说：来源版本与被装版本**不同** → 「更新到 vX」；**相同** → 「重新安装」。
  - 开关取消后，行内用「已停用」这几个字表达停用态（结构只在携带信息时才出现）。
  - 覆盖见 `test/verify-plugin-row-menu.mjs`（11 条：行内只有一个按钮/无开关、菜单三档、
    **真的把旧版本更新回应用包版本**、停用后菜单项变「启用」且行里标已停用、启用后标记消失、
    卸载仍走数据确认框且取消后插件还在）。
- **升级清理**：曾经内置、现在移出应用的 id（`planner` / `music`）由 `plugins.json.seeded` 识别，
  启动时删掉它们的旧代码目录（数据保留）——`test/probe-retired-builtins-cleanup.mjs` 覆盖。
- **卸载**：弹确认框，**代码与数据是两件事**（2026-09-26 用户口径）——
  - 卸载本身 = **移除插件代码**：删 `userData/plugins/<id>/`、写 `uninstalled`、清启用覆写 → 广播；
  - 勾选项「同时删除该插件的全部数据」= **额外**清数据：先调插件的 `plugin.purge` 贡献
    （此时插件仍装载，能删自己的表数据/托管文件），再走上面的移除流程；
  - **不勾** = 数据原样留在库里（表行在、应用托管的文件也在），重装后照旧可用
    ——`test/probe-uninstall-keep-data.mjs` 实测：不勾卸载 → 代码没了但歌单行仍是 1、
    托管歌单目录仍在，重装后歌单原样回来；勾上卸载 → 行归 0、托管目录被删。
  - 勾选项正文里的「包含：……」来自插件 `plugin.purge` 贡献的 `label`，经 `PluginListEntry.purgeLabel`
    下发给面板（插件停用/未装载时拿不到 → 回退成「包含该插件的全部业务数据」）。
- **数据清除由插件自己实现**（`ctx.contribute(PLUGIN_PURGE, { run })`），core 不硬编码表名：
  - music（独立插件 `music-player`）：`music_folders` / `music_tracks` 行 + 应用托管的歌单目录（`musicDirectory/<uuid>`，**不删
    ** `musicDirectory` 本身）
  - planner（独立插件 `task-planner`）：`planner_tasks` / `planner_dependencies`
  - notes：`graph_relations`/`graph_entities`/`graph_build_jobs`、`directory_documents`、`documents_content`、
    `wiki_directories`、`documents`、`wiki`、`task_dependencies`、`todo_items`、`node_positions`、
    `images`（只删本插件引用的那些行）、设置键 `graph`（**用户文档会被删，确认框必须写清楚**）
  - harness：topics / dialogues / goals / usage / agent configs + Mnemon 存储目录（按工作区）
- `PluginListEntry` 增 `bundled`/`installed`/`purgeLabel`；面板分区：**已安装**（内置 / 第三方，各有「卸载」+ 开关）与
  **可安装的内置插件**（仅当有未安装项时出现，行内一个「安装」按钮）。

## 分轮实施

> **改名记录（2026-09-26）**：内置插件 `home` 已改名为 `notes`——目录、id、路由（`/notes`）、
> 菜单键、词条命名空间（`notes.*`）、通道前缀（`plugin:notes:*`）一并改；
> **菜单图标保持原样**（仍是 `RiDashboardLine`，用户明确要求不动图标）；
> 数据表名与 AI 工具名（`manage_docs` / `manage_todos` / `manage_wikis` / `search_graph`）不变。
> 旧 profile 里铺下的 `userData/plugins/home` 由启动时的 `removeRetiredBundledPlugins()` 清掉（数据保留）。
> 工装同步改名：`test/verify-plugin-home-package.mjs` → `test/verify-plugin-notes-package.mjs`
> （60 条断言全绿），`test/verify-plugin-host.mjs` 改为「两个内置插件」口径（58 条断言全绿），
> 其余探针的 `plugin:home:*` / `#/home` / 「首页」文案一并更新。
> **下表 P0~P5 里的 `home` 均指今天的 `notes`**（历史记录按当时的名字保留）；P6 起独立插件
> `task-planner` / `music-player` 已移出应用。

| 轮    | 内容                                                                                                                                                                                                                                                                                                                                                                   | 验收                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| P0 ✅ | `scripts/build-plugins.mjs`：四插件打成 `resources/plugins/<id>/{plugin.json,main.cjs,renderer.mjs}`，`@host/**` 与第三方裸模块外置，manifest 由 `manifest.ts` 生成（单一真源）                                                                                                                                                                                                                | 四个包产出（dev：music 113/293KB、planner 107/221KB、home 666/898KB、harness 1722/2565KB），外置清单与本文契约一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P1 ✅ | 宿主运行时（main `globalThis` + require 垫片；renderer `plugin://host/ui.js` 桥 + CSP `plugin:`）+ 首次安装 copy + **用 music 端到端**跑通 + **首帧声明式预注册**（见下节）                                                                                                                                                                                                                            | 应用里 music 从 `userData/plugins/music` 装载；首帧侧栏即为「首页/计划/音乐/助手」（`test/probe-first-frame-menu.mjs`）；卸载（不保留数据）后目录/表数据/菜单/通道全没了，重启不会自动铺回来，重装后原样回来；`verify-plugin-host` 61 条全绿、`verify-plugin-install-uninstall` 47 条全绿（P1~P4 期间该工装的「哪些 id 已就绪」由 `packaged.ts` 驱动，P5 起恒为全集）                                                                                                                                                                                                                                                                                                                      |
| P2 ✅ | planner 同款（外加 planner 自己的 `plugin.purge`：`planner_dependencies` → `planner_tasks`；另把 **dayjs 纳入宿主 vendor 桥**，见上节）                                                                                                                                                                                                                                                    | planner 从 `userData/plugins/planner` 装载（`loadedFrom().planner.source === 'package'`）；`plugin:planner:tasks-add` 由磁盘包应答并落库；卸载（不保留数据）后目录/两张表行/菜单/路由/`plugin:planner:*` 通道/harness 工具清单里的 `manage_planner` 全没了，且不碰 music 的数据；重启不会自动铺回来，重装后原样回来（数据仍为空）；`verify-plugin-planner-package` 46 条全绿，P1 工装（`verify-plugin-install-uninstall` 47 条 / `verify-plugin-host` 61 条 / 首帧与三个探针）仍全绿                                                                                                                                                                                                         |
| P3 ✅ | home 同款（含 GraphView 懒加载 chunk 仍在）+ **渲染层改成多文件产物**（入口 + `chunk-<hash>.mjs`，见上节）+ home 自己的 `plugin.purge`（文档/正文/目录/知识库/图谱/待办/画布坐标/图片 + 设置键 `graph`）                                                                                                                                                                                                                    | home 从 `userData/plugins/home` 装载；入口 118.0KB（**不含 echarts**）+ 懒加载 `chunk-IZPBTTMD.mjs` 1134KB，首屏只取入口与入口静态共享的 chunk，打开图谱才取懒加载那个（CDP Network 域实测）；7 类数据经磁盘包 handler 落库；卸载（不保留数据）后目录/菜单/路由/通道/harness 工具清单与 8 张表行数全清（images 也归 0）、不碰 music 的行、默认落地页从 `#/home` 退到 `#/planner`，重启不会自动铺回来，重装后原样回来（数据仍为空）；`verify-plugin-home-package` 57 条全绿                                                                                                                                                                                                                                                   |
| P4 ✅ | harness 同款 + harness 自己的 `plugin.purge`（7 张表 + 三处托管目录：`userData/file-history`、`userData/tool-output`、`<memoryPath>/workspace-<id>` 与 `spill`）；**新增离线契约审计** `test/audit-plugin-host-contract.mjs`                                                                                                                                                                     | 四个插件全部从 `userData/plugins/<id>/` 装载（`loadedFrom().*.source === 'package'`）；harness 入口 111KB + 32 个 chunk（1712KB），打开助手只取 5/32 个 chunk；工作区/话题/子代理经磁盘包 handler 落库；卸载（不保留数据）后目录/菜单/路由/63 个通道/三个宿主钩子（preload·beforeQuit·memoryDump）与 7 张表行数全清，`<memoryPath>/workspace-<id>`、`spill`、`file-history`、`tool-output` 被删而 **`memoryPath` 本身、core 的 `workspace` 表、设置键 `harness` 保留**；重启不会自动铺回来，重装后原样回来（话题为空）；`verify-plugin-host` 61 条 / `verify-plugin-install-uninstall` 47 条 / `verify-plugin-planner-package` 46 条 / `verify-plugin-home-package` 57 条 / `verify-plugin-harness-package` 50 条全绿 |
| P5 ✅ | 删掉三处过渡物：应用内静态注册表（`main/plugins/builtin.ts`、`plugin-host/builtin.ts`）与白名单 `packaged.ts`；`stateSyncHook` / `syncBuiltinPluginIpcs` / `isPackageReady` 判断全部移除；`electron-builder.yml` 加 `resources/plugins` → `extraResources`；`build:win/mac/linux/unpack` 前置 `build:plugins`；**dev 下自动补打产物**（缺产物或产物落后于源码 → `--plugin <id> --dev`）；面板去掉「过渡期只有开关」的分支；README/MIGRATION 收尾 | `node test/verify-plugin-restructure.mjs` 断言「应用内零插件实现 import」+ 三处过渡物已删；`App.tsx` 的初始插件集合恒为空数组，四个插件的路由/菜单/设置页/provider 全靠清单元数据声明 + 磁盘包异步注册；`test/probe-dev-package-fallback.mjs` 实测「移走 `resources/plugins` → 启动即自动补打四个包并全部装上；只改一个插件的源码 mtime → 只重打那一个」；**打包产物实测**（`pnpm build:unpack` + `test/probe-packaged-app-plugins.mjs`：把仓库的 `resources/plugins` 临时移走，打包应用仍从自己的 `resources/plugins` 铺出四个包，证明走的是 `app.isPackaged` 分支且没有误走 dev 补打）；全套 CDP 工装（61/47/46/57/50 条断言 + 6 个探针，含 `probe-uninstall-keep-data.mjs`：不勾 = 只删插件代码、数据留在库里且重装后原样回来；勾上 = 连数据一起清）在**删掉静态注册表之后**仍全绿                    |
| P6 ✅ | **planner 与音乐移出应用、改成独立插件**：源码进 `Aitenry/ryten-plugins`（目录名与 id = `task-planner` / `music-player`，源码直接写 `@host/**`，自带 `host.d.ts` 与构建/发布 CI），应用侧新增「从插件仓库安装」（索引 + Release 资产 + sha256 校验 + 解压安装）                                                                                                                                                                       | 应用不再分发这两个插件（首启只有 笔记/AI 助手）；从 fixture 服务器走完整链路安装：索引 → 下载 zip → sha256 → 解压 → 装入 `userData/plugins` → 自动启用 → 菜单/界面可用；插件自带 DDL 在宿主库建出 `planner_tasks` / `music_folders`；两者在清单里是第三方（builtin/bundled=false）；卸载（含 purge）后它建的表行归 0；`verify-github-plugin-install` 19 条全绿；老 profile 升级时旧 `planner`/`music` 铺包被清理（`probe-retired-builtins-cleanup`）                                                                                                                                                                                                                                               |

## 契约漂移的离线审计（P4 落地）

`node test/audit-plugin-host-contract.mjs`：不启动应用，直接读四个包的产物，抽出
主进程的 `__RB_HOST_RESOLVE__("…")` 说明符与渲染层入口/chunk 里的 `plugin://host/ui.js?m=…` 键，
跟 `src/main/plugins/runtime.ts`、`src/renderer/src/plugin-host/host-ui.ts` 两张表比对，
顺带核对裸模块都在 `package.json` 的 dependencies 里。

为什么非要有它（P4 实测）：给 harness 加 `plugin.purge` 时，purge **静态** import 了
`db/schema/**`，而这些 schema 模块 import 了 core 的 `@host/main/database/schema/workspace`——
那个键当时不在运行时表里。同样的导入以前只出现在 `await import('../db/mapper/…')` 里，
失败被推迟到「真的用到某个工具」；改成静态导入后变成**插件包整体装载失败**
（日志：`外部插件 'harness' 主模块启动装载失败`，现象：主进程通道一个不剩，界面菜单还在但
所有调用都报「无处理器」）。当时只能靠跑真实 Electron 才发现——本审计把这类漂移挡在启动之前。

## 首帧声明式预注册（P1 落地，P5 复用同一机制）

**问题**：磁盘包插件的渲染模块要 `fetch` + `import` 之后才 `install(ctx)`，而静态内置插件在宿主构造期
就同步注册完了。于是磁盘包插件的菜单/路由「晚几百毫秒才弹出来」，首帧侧栏缺它——点击侧栏还会导航到
空路由（`No routes matched`）。

**做法**（三端各一小步，没有新增协议）：

1. 主进程 `plugins-list` 的每个条目带上清单里的 `routes`/`menu`（`PluginListEntry.routes/menu`，
   与 `PluginManifest` 同形；磁盘包读 `plugin.json`，过渡期的静态内置插件直接用
   `BUILTIN_PLUGIN_MANIFESTS`）。
2. 渲染层 `PluginHost.declare(id, { menu?, routes? })` 把这份元数据记进**声明表**（按 id 记账）；
   `getMenus()`/`getRoutes()` 返回「真实注册 + 尚未被真实注册覆盖的声明」——同一 `key`/`path`
   **以真实注册为准**，顺序仍按 `order`。声明项只有元数据，路由落到 `MainRoutes` 的
   `PluginRouteView` 时会走「既无 `load` 也无 `Component`」分支，渲染 `<RouteSkeleton>`。
3. `App.tsx` 用已有的同步 `api.plugin.listSync()` 结果构造声明，`PluginHostProvider` 在**构造宿主
   的同一渲染周期内**（早于任何子组件）调用 `declare`。P5 起应用里没有静态插件，**所有**插件都靠
   这份声明撑住首帧（随后各自的渲染模块加载完成、真实注册按 key/path 覆盖声明项）。
4. 清理：`disable()`（含 withdrawal 连带卸载）与 `forgetPlugin()`/`removeExternal()` 都删掉该 id 的
   声明，否则停用/卸载后菜单会残留。
5. 图标：清单里 `menu.icon` 是**名字字符串**（`RiDiscLine`），声明项由
   `plugin-host/declared-icons.tsx` 显式映射成节点，未知名字回退通用图标；**真实注册仍由插件自己传
   组件**，不经过这张表。

**P5 之后**：声明机制成为首屏的**唯一**支撑（应用里已无静态插件注册表，删掉的正是过渡期的
`main/plugins/builtin.ts`、`plugin-host/builtin.ts` 与 `packaged.ts` 白名单）。
`test/probe-first-frame-menu.mjs` 断言的就是这条：首帧侧栏即含「笔记/助手」，
而两个磁盘包此时一个都还没加载完（独立插件装上后的首帧同样靠声明式预注册，
由 `test/verify-github-plugin-install.mjs` 覆盖）。

### 卸载的边界（P1 实测踩到，P2~P4 同样适用；P5 后第 2 条随静态回退一起作废）

- **卸载必须记 `uninstalled`**：内置插件走 `removeBundledPlugin()`（删目录 + 记账），不能复用第三方语义的
  `uninstallExternalPlugin()`（只删目录），否则下次启动 `ensureBundledPluginsInstalled()` 立刻把包铺回来。
- **未安装就不该有静态回退**（P1~P4）：`builtin.ts` 的遮蔽规则是「已装包 **或** 用户卸载过」都遮住静态模块。
  否则卸载后重启时主进程通道被静态模块装回来（界面按未安装处理），之后从面板「安装」会撞
  Electron 的「Attempted to register a second handler」。P5 删掉静态注册表后这一类问题从根上消失。
- **停用 ≠ 移除登记**：渲染层桥对「只是停用」的插件调 `host.disable()` 而不是 `forgetPlugin()`——登记一丢，
  重新启用时就再也回不来（会去 `plugin://<id>/renderer.js` 找一个已经不在加载路径里的模块）。
- **不勾删除数据 ≠ 不卸载**（2026-09-26 用户澄清后修正）：早先的实现把 `purgeData: false` 直接拒绝
  （「保留数据 = 不卸载」），现在它是「卸载代码但留数据」。留数据的前提是**表结构不随卸载删**
  （迁移由 core 统一应用），所以重装后插件能读到自己的旧行——`probe-uninstall-keep-data.mjs` 覆盖了这条。

## 风险与既有约束

- **dev 模式已落地**：`pnpm dev` 下若 `resources/plugins/` 不存在、或某个插件的产物比源码旧
  （改了插件源码忘了重打包），`installer.ensureDevPackagesBuilt()` 会用同一个脚本
  `--plugin <id> --dev` 补打那一个（不压缩 + inline sourcemap），再走正常安装流程。
  只有 `app.isPackaged === false` 时生效；打包产物由 `pnpm build:win|mac|linux`
  前置的 `build:plugins` 保证。回归探针：`test/probe-dev-package-fallback.mjs`
  （移走产物目录 → 启动 → 断言四个包被补打且装上 → 只碰源码 mtime → 断言只重打那一个 → 恢复目录）。
- **主进程单例**：`globalThis` 交接必须发生在任何插件 `main.cjs` 被 `require` 之前（`initPluginHost()` 开头）。
- **数据库**：插件的表仍由 `src/main/database/schema/index.ts` 汇总（迁移统一由 core 应用）；卸载**不删表**（DDL 不变），
  只由 `plugin.purge` 删行，避免出现「卸载后迁移对不上」的库。
- **CSP**：渲染层插件包从 `plugin://` 加载 `<script type="module">` 需要在 CSP 里放行 `plugin:`；找不到桥时给出明确报错而不是白屏。
- **类型检查**：源码 import 不变，`typecheck` 仍能发现插件用错 core API；`@host/**` 只存在于构建产物里。
