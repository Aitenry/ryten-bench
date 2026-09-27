# 插件工坊（Plugin Workshop）

> 「和助手对话，把插件做出来」——助手写代码，工坊负责**构建 → 自动验收 → 装进应用**，
> 用户只在设置页看结果。功能入口：**设置 → 助手 → 插件工坊**（`src/plugins/harness`）。

## 它解决什么

外部插件（`userData/plugins/<id>/`）的失败模式几乎都发生在「写好了但装不上 / 装上了但界面不出来」：

- 主进程引了宿主运行时表里没有的 `@host/main/**` 键 → 整个插件主模块装载失败，
  表现是「菜单还在、所有调用都报无处理器」；
- 渲染层引了宿主 UI 表里没有的模块、或把宿主说明符留在 chunk 里 → 白屏 / 解析失败；
- 通道名没落在自己的命名空间 → 宿主在装载期直接抛错；
- `install()` 第一行就抛（读文件/读设置）→ 插件「装上了但全哑」；
- 用了 Tailwind 类名却没带 `plugin.css` → **界面变形**（2026-09-26 的真实事故）。

这些错误靠「看一眼代码」很难发现，靠「装上去试试」又要用户自己承担。工坊把这条链路自动化：
**构建期能查出来的在构建期查，查不出来的用真实装载冒烟查，仍然查不出来的让真界面跑一遍。**

## 目录约定

```
<userData>/plugin-workshop/
  drafts/<id>/            草稿源码（助手唯一的编辑面；id = 插件 id = 目录名）
    plugin.json           清单（entry 由构建写入，助手不手写）
    WORKSHOP.md           契约单（生成时注入**运行期**的宿主模块白名单）
    main/index.ts         主进程入口（可缺省，产物仍会有一个空 main.cjs）
    renderer/plugin.tsx   渲染层入口（必需）
    renderer/*.tsx        页面/组件（被 load() 引用的会拆成懒加载 chunk）
    plugin.css            可选：手写样式（workshop.json 的 css='file' 时原样进包）
    workshop.smoke.mjs    可选：通道级冒烟用例
  dist/<id>/              构建产物（= 可安装插件包，与插件仓库 dist/<id> 同构）
  reports/<id>.json       最近一次验收报告
  exports/<id>-<v>.zip    导出的可分发压缩包
```

## 工作流（助手侧）

```
plugin_draft    create/list/tree/read/write/remove（草稿与文件）
plugin_build    构建 + 静态体检（宿主说明符、第三方依赖、语法、chunk 绝对化、样式覆盖）
plugin_verify   构建 + 十一项验收电池（含真实装载冒烟与渲染层探针）
plugin_publish  install / disable / uninstall / export（装进应用并启用）
```

四个工具刻意按**工作流的四步**切开，而不是把十几个动作塞进一个工具：每一步的失败都要给出
「那一步专属」的可执行诊断（构建失败给 esbuild 的 `文件:行:列`，验收失败给逐项 PASS/FAIL 与建议）。

前提：工具要挂到助手身上（`mainAgent.tools`）。工坊页在检测到没挂时给一个「一键启用」按钮
（只加不减，不动用户已有的勾选）。

## 验收电池（`verify.ts`）

| id | 检查 | 致命 | 说明 |
|----|------|------|------|
| `pkg.manifest` | 清单字段齐备、id 与目录一致、`builtin=false` | ✅ | 语义错误给「改哪个字段」级别的提示 |
| `pkg.build` | 构建产物（esbuild 诊断） | ✅ | 第三方依赖错误直接列出宿主可用的 vendor |
| `pkg.entries` | `plugin.json` / `main.cjs` / `renderer.mjs` 存在且非空 | ✅ | |
| `pkg.identity` | 不是保留 id / 内置 id / 别人占用的命名空间 | ✅ | 命名空间撞车按 `plugin.<ns>` 与 `<ns>` 同源判定 |
| `pkg.host-main` | 主进程引的 `@host/**` 都在运行时表里、裸依赖能解析 | ✅ | 与 `test/audit-plugin-host-contract.mjs` 同源口径 |
| `pkg.host-ui` | 渲染层引的宿主键都在宿主 UI 表里，且产物里没有残留裸说明符 | ✅ | |
| `pkg.chunks` | 产物里没有相对说明符（blob import 会取不到） | ✅ | |
| `main.smoke` | **真的 require `main.cjs` 并用真实 `install(ctx)` 契约驱动一遍** | ✅ | 记录版上下文：不碰 ipcMain；跑完 LIFO 回滚 + dispose 幂等 + 清 require 缓存 |
| `renderer.probe` | 真渲染进程里 fetch → blob import → `install` → 挂载一次 | ❌ | 插件未安装时 SKIP（发布后会自动复验） |
| `style.coverage` | `className` 用到的类名在 `plugin.css` 里都有规则 | ❌ | 只查 `className` 位置（loose 字面量只用于喂 Tailwind，避免误报） |
| `risk.scan` | 危险 API 清单（child_process / process.exit / eval…） | ❌ | 插件在主进程有完整权限，发布前提示用户 |

致命项全过 = **装上去能用**；非致命项失败 = 能跑但不对。

### 渲染层探针为什么值得单独一条链路

主进程冒烟只能证明「主模块能装载」。外部插件最真实的失败是**渲染模块在宿主环境里 import 就炸**
（宿主 UI 表没有那个键、桥的具名导出对不上、注册的组件一渲染就抛）。探针在真 React / 真 antd /
真 `__RB_HOST_UI__` 表里跑一遍，并且：

- 上下文是**记录版**（注册进数组，不改动用户界面）；
- `install` 之后把所有 effect 逆序回滚，顺手验证「插件可停用」；
- 把插件声明的 `labelKey` 拿真 i18n `exists()` 逐个核对——**词条命名空间写错**（把语言当命名空间）
  是外部插件最常见也最难自查的一类错，界面上的表现只是「菜单显示 `x.menu.title`」。

## 发布与回滚

- 发布走**宿主既有的安装链路**（`installPackageDir` → `setEnabledOverride` → `loadExternalMain`
  → `broadcastPluginStateChanged`），与设置页里的「从本地安装」「从插件仓库安装」是同一批函数；
  工坊不另造一条，否则升级清理、卸载记账、渲染层重载迟早分叉。
- **装完立刻复验**：安装后自动跑一次渲染层探针；失败就**自动卸载回滚**并报原因——
  用户机器上不会留下「点了就白屏」的插件。
- `plugin_publish install` 在**没有一次通过的验收**（或产物比源码旧）时直接拒绝：
  「没验过的插件大概率是坏的」比「装完再解释」便宜得多。
- 卸载分两件事（与全应用口径一致）：**卸载插件代码**（`plugin_publish uninstall`）与
  **删除草稿**（`plugin_draft remove`）互不影响；数据是否一起删由宿主卸载确认框的勾选项决定，
  工坊模板都会带一份 `PLUGIN_PURGE` 贡献，把「删什么」写清楚。

## 实现要点（踩过的坑，改之前先读）

1. **宿主依赖是注入的**：`main/workshop/host.ts` 定义 `WorkshopHost`，`main/workshop/wiring.ts`
   是**唯一** import electron / core 的地方，其余模块只依赖 node 内置模块 —— 因此离线工装
   （`test/verify-plugin-workshop.mjs`）能用临时目录 + 假宿主把整条链路跑真。
2. **渲染层的宿主说明符必须在构建期改写成 `plugin://host/ui.js?m=<键>`**：
   懒加载 chunk 是浏览器按 `plugin://<id>/chunk-x.mjs` 自己取回来的，那条路径**没有**任何运行期
   改写机会（宿主 `external-loader.ts` 只改入口）。2026-09-27 真机实测：chunk 里残留 `from "react"`
   → `Failed to resolve module specifier "react"`。
3. **宿主运行时表的这三类键要懒加载**（`runtime.ts` 的 `lazyHostModule`）：
   `plugins/host.ts` import 了 `runtime.ts`（`installHostRuntime`），而工坊要的
   `plugins/{host,lifecycle,package-install,scanner,store}` 与 `ipc/plugins` 又（直接或间接）
   import 回 `host.ts` —— 静态 import 会成环，先求值的一侧拿到「函数还没挂上」的半成品命名空间，
   表现是 `isBundledPluginId is not a function`。懒加载代理的描述符必须报 `configurable: true`，
   否则 esbuild 的 `__toESM` 会撞 Proxy 不变量。
4. **发布必须广播 `plugin-state-changed`**（`wiring.notify`）：渲染层靠它重新拉清单、
   去 `plugin://` 取新插件的 `renderer.mjs` 并注册菜单/路由。少了这一句，插件装上了、
   通道也能用，但侧栏永远不出现 —— 极易误判成「没装上」。
5. **词条 API 是 `addResources(命名空间, { 语言: 词条树 })`**（见 `plugin-host/host.ts`）：
   写成 `addResources('zh-CN', …)` 是把语言当命名空间，界面显示原始键名。模板与 WORKSHOP.md
   都按正确形态生成，探针也会点名。
6. **样式生成用 Tailwind 的 JS API**（`css.ts`）：候选由我们自己给（`compile().build(candidates)`），
   完全不触发 Tailwind 的文件扫描 —— 打包后的应用里 `@tailwindcss/oxide`（原生模块）未必可用。
   Tailwind 装不上时降级为「不带样式」，由 `style.coverage` 如实点名。
7. **构建需要 esbuild**：从应用根 / `app.asar.unpacked` 逐个基准解析（`createNodeLoader`）。
   打包后的应用若要支持工坊构建，需把 esbuild 放进 `dependencies` 并加进 `asarUnpack`
   （拿不到时给的是可读错误，不是崩溃）。

## 回归

| 工装 | 覆盖 |
|------|------|
| `node --experimental-strip-types test/verify-plugin-workshop.mjs` | 离线 107 条：四个模板全链路、id/路径安全、产物形态、正例验收、**反向电池**（十余种坏法逐个断言命中哪一项检查）、发布/停用/卸载/导出、探针参与验收、工具层、源码守卫 |
| `node test/probe-plugin-workshop-live.mjs` | 真机 28 条：工坊通道与设置页、助手工具、建草稿 → 构建 → 验收（含真界面探针）→ 发布 → 菜单出现 → 通道可用 → 卸载（保留数据）→ 删草稿 |
| `node test/audit-plugin-host-contract.mjs` | 构建产物里的 `@host/**` 说明符与宿主表一致（工坊新增的 7 个键在这里兜底） |
