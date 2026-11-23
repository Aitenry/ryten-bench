# 插件工坊契约（${vars.id}）

> 这份文件由工坊生成，是**改这个插件时的唯一契约来源**。改完代码用工具走一遍：
> `plugin_build`（构建）→ `plugin_verify`（自动验收）→ `plugin_publish`（装进应用启用）。

## 1. 这个草稿是什么

- 插件 id：`${vars.id}`（= 目录名 = plugin.json.id = IPC 命名空间 `plugin:${vars.id}:*`）
- 模板：`${vars.template}`（${vars.templateLabel}）—— ${vars.templateDescription}
- 已注册：${vars.templateRegisters}

## 2. 文件职责

布局与插件中心里的真实插件一致——每个文件一个职责，助手改哪块就只看哪块：

| 文件 | 作用 |
|------|------|
| `plugin.json` | 插件清单（id/name/version/description/inject/routes/menu）。**不要手写 entry**，构建时写入 |
| `shared/types.ts` | 跨进程 DTO（主进程与渲染层共用一份形状；**不许** import drizzle/electron/node） |
| `main/index.ts` | 主进程入口：`export function install(ctx)`，**只做装配**（建表 side-effect / 通道 / 事件 / 工具 / 清数据） |
| `main/ipc.ts` | 通道实现 + 设置落盘 + 变更推送（`ITEMS_CHANGED` 这类事件常量也在这里） |
| `main/tools.ts` | 给助手贡献的 AI 工具（`HARNESS_TOOL_CONTRIBUTION`） |
| `main/tool-texts.ts` | 工具的返回文案（中文 / 英文，跟随界面语言） |
| `main/purge.ts` | 卸载清数据（删自己的表行 + 应用托管的数据；挂 `PLUGIN_PURGE`） |
| `main/db/ddl.ts` | **本插件自带建表**（幂等 `IF NOT EXISTS`）+ `schemaReady` 承诺 |
| `main/db/schema.ts` | drizzle 表定义（查询用；行类型 `$inferSelect` 的单一真源） |
| `main/db/mapper.ts` | 数据访问（统一走宿主 `withOrm`；行 → DTO 只在这里转） |
| `locales/{index,zh-CN,en-US}.ts` | 词条（渲染层 install 时注册；英文逐键对齐中文） |
| `renderer/plugin.tsx` | 渲染层入口：`export default { install(ctx) }`，**只做装配**。**必需** |
| `renderer/api.ts` | 主进程通道的薄封装（组件不直接写通道名） |
| `renderer/Page.tsx` / `renderer/Settings.tsx` | 页面与设置页（路由的 `load()` 指向它们才会拆成懒加载 chunk） |
| `renderer/components/ui.tsx` | **布局与配色原语**（PageShell / Panel / pageTabsProps / formModalProps / FitTable / FitList / ChartBox / usePluginPalette）。页面与组件都从这里取，**别自己重新发明根节点与弹窗样式**——第 6 节的坑都在这一个文件里解决掉了 |
| `renderer/components/*.tsx` | 拆出来的组件（表单弹窗这类状态多的块别塞进页面） |
| `plugin.css` | 可选：手写样式（`workshop.json` 的 `css: 'file'` 时原样进包）。默认 `auto`，由工坊用 Tailwind 扫源码生成 |
| `workshop.smoke.mjs` | 可选：验收电池要跑的通道级冒烟用例 |
| `renderer/context.ts` / `main/context.ts` | 宿主上下文的最小类型声明（**不随包分发**，仅供写代码时参考） |

## 2b. 宿主怎么装载它（理解这四条，少走大半弯路）

1. **两个入口、两种模块格式**：主进程 `main.cjs` 是 **CJS**（构建时打成单文件，导出
   `install(ctx)`）；渲染层 `renderer.mjs` 是 **ESM**，宿主 `fetch` 下来用 blob URL
   `import`，其中的动态 import 会被拆成 `chunk-*.mjs`（相对说明符由构建重写成
   `plugin://<id>/…`，因为 blob 模块没有相对基准）。
2. **依赖不随插件打包**：`@host/**` 在构建时被改写成**宿主自己的模块实例**（同一份 ORM /
   设置 / i18n / React / antd 单例），裸依赖（`electron`、`zod`、`drizzle-orm`、`react`、
   `antd`…）按应用根解析。**不要在插件里再打一份 core / React / antd**，也不要自己连数据库——
   那会得到第二个连接、第二份状态，行为与宿主不一致。
3. **资源只能从自己的包目录取**：`plugin://<id>/<相对路径>`（图标、图片、额外 JSON）；
   不要假设能读工作区或别的插件。可选资源要能缺失（宿主对缺失文件回 404，自己做兜底）。
4. **升级不重启应用**：宿主会先 teardown 旧模块、摘掉 `require` 缓存，再用磁盘上的新代码
   重装（详见第 5 节）。所以 `install` 必须可重跑，`ctx.effect` 注册的定时器/监听必须
   在回滚时真的停掉——否则升级后会出现「两个定时器」「旧监听还在」这类幽灵状态。

## 3. 清单字段（plugin.json）

```jsonc
{
  "id": "${vars.id}",            // 小写 kebab，必须与目录名一致，不可再改
  "name": "${vars.title}",       // 展示名
  "version": "0.1.0",            // 改了代码要升版本（面板据此显示更新）
  "description": "…",
  "inject": ["route", "menu", "settingsSection", "appProvider", "i18n", "events", "storage"],
  "routes": [{ "path": "/${vars.id}" }],                                   // 可选
  "menu": { "key": "${vars.id}", "labelKey": "${vars.id}.menu.title", "icon": "${vars.menuIcon}", "order": 60 }
}
```

## 4. 渲染层契约

```ts
ctx.use('route').register({ path: '/x', load: () => import('./Page') })
ctx.use('menu').register({ key: 'x', labelKey: 'x.menu.title', icon: <${vars.menuIcon} size={16} />, order: 60 })
ctx.use('settingsSection').register({ tabKey: 'x', labelKey: 'x.settings.title', icon, group: 'assistant', order: 90, Component: Settings })
ctx.use('appProvider').register({ Provider, order: 90 })
ctx.use('i18n').addResources('translation', {
  'zh-CN': { x: { menu: { title: '名字' } } },
  'en-US': { x: { menu: { title: 'Name' } } }
})
ctx.effect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t) })
```

- **菜单键必须等于路由路径去掉斜杠**（`key: 'x'` ↔ `path: '/x'`）：点击菜单就是 `navigate('/' + key)`；
- 词条注册的**第一个参数是 i18next 命名空间**（宿主界面一律 `'translation'`），第二个参数是
  「语言 → 词条树」。写成 `addResources('zh-CN', …)` 是把语言当成了命名空间，
  菜单/设置页会显示原始键名（`x.menu.title`）；
- 一切注册都随插件停用回滚，**不要**自己写反注册；
- 调主进程一律 `window.api.plugin.invoke('plugin:${vars.id}:<name>', ...args)`（或草稿里的 `invoke()`）。

### 可用的宿主模块（渲染层）

只有下面这些键（外加 `react` / `react-dom` / `antd` / `@remixicon/react` / `@ant-design/icons` / `dayjs`
这些宿主已有唯一实例的 **vendor** 可以直接裸导入）能在产物里保留为外部依赖；
**其它第三方包一律没有**（草稿目录里没有 node_modules），import 了会构建失败：

${vars.uiKeys}

## 5. 主进程契约

```ts
export function install(ctx) {
  ctx.registerIpc({ 'plugin:${vars.id}:do-something': async (arg) => result })
  ctx.registerEvent('plugin:${vars.id}:pushed')   // 只推送、无 handler 的通道必须声明
  ctx.effect(() => { start(); return () => stop() })
  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, { name, info, build })  // 给助手加工具
  // 卸载时勾了「同时删除数据」才会跑：清自己的数据文件/表行（label 会显示给用户看）
  ctx.contribute(PLUGIN_PURGE, { label: '本插件的数据', run: () => { /* 删自己的东西 */ } })
}
```

- 通道名**必须**以 `plugin:${vars.id}:` 开头，否则装载期直接抛错；
- **`install(ctx)` 在同一进程里可能被调用不止一次**：停用后重新启用、以及
  `plugin_publish install` **升级**已安装的插件时，宿主会先 teardown 旧模块、摘掉它的
  `require` 缓存，再用磁盘上的新代码重新 `install`（主进程与渲染层一起换新，用户
  **不需要重启应用**）。所以 `install` 必须是**可重复执行的幂等装配**：建表一律
  `IF NOT EXISTS`、进程级状态用 `ctx.effect` 登记并在回滚时清掉；别假设「这个进程里我
  只被装一次」，也别在装载期做只能做一次的事（写一次性文件、消耗令牌、改宿主设置）。
  升级后点新功能报 `No handler registered for 'plugin:…'` 就是「新渲染层 + 旧主进程」的
  老症状（用户以前只能完全重启应用），现在宿主会自己重载，插件侧只需保证 `install` 能重跑；
- 主进程可以直接 import `electron` / `electron-log` / `zod/v4` / `@host/main/ai/tools` 等宿主已装依赖；
- 数据请落在 `app.getPath('userData')` 下（别写用户工作区）。

### 可用的宿主模块（主进程）

${vars.mainKeys}

## 5b. 数据与表（要存东西时照这个来）

独立插件的表**归插件自己管**：宿主不认识它们，迁移链里也没有它们。

```ts
// main/db/ddl.ts —— 建表：幂等 + 只动自己的表（表名必须带插件前缀）
const DDL = [`CREATE TABLE IF NOT EXISTS ${vars.itemsToolName} ( id SERIAL PRIMARY KEY, … )`]
export const schemaReady = (async () => {
  await withOrm('${vars.id}.ensureSchema', async (db) => {
    for (const s of DDL) await db.execute(sql.raw(s))
  })
})()

// main/db/mapper.ts —— 每个函数先 await schemaReady，再走 withOrm
export async function listItems() {
  await schemaReady
  return withOrm('${vars.id}.listItems', async (db) => db.select().from(${vars.itemsToolName}))
}
```

- **表名前缀 = 插件 id 的 SQL 形态**（`${vars.sqlName}_`）：一个库里装着所有插件的表，撞名就是事故；
- **表结构只做加法**：升级用 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`；
  不删列、不改列类型、不改主键（旧数据会丢，卸载重装后的库还会和迁移记录分叉）。
  数据迁移写成**幂等 UPDATE**（带 `WHERE` 保护、目标键已存在时跳过）——真实插件
  （比如 douyin-link）就是这么把旧画像键补上角色后缀的，升级不丢用户已经花过钱的数据；
- `@host/main/database/orm` 的 `withOrm(op, fn)` 给 drizzle 实例并统一记异常（务必用它，别自己拿连接）；
- `schemaReady` 是承诺：装载即建表，但**不保证建表先于第一次查询**，mapper / purge 都要 await 它；
- **插件是在数据库初始化之前被装载的**（宿主 `initPluginHost()` 早于 `createLoadingWindow()`）：
  `withOrm` 会等库就绪，所以装载期调用它是安全的，但**别在装载期同步等它**、也别「先读库再导出同步状态」；
- **应用数据进表**（可查询、AI 工具能读），**设置进 JSON**（`userData/plugin-state/${vars.id}.json`）；
  用户的工作区是他的项目目录，**任何数据都不要写进去**。

## 5c. 词条（界面上要显示的文字）

- 词条放 `locales/zh-CN.ts` 与 `locales/en-US.ts`，由 `locales/index.ts` 汇总；
  渲染层 install 里 `ctx.use('i18n').addResources('translation', ${vars.pascal}Locales)` 注册；
- **英文逐键对齐中文**（用 `typeof zhCN` 约束，删/加键都会编译报错）——
  别把中文抄进 en-US，切到英文就露馅；
- 组件里一律 `t('${vars.id}.page.xxx')`，不写死文案；工具返回的文案放 `main/tool-texts.ts`
  （`getMainLanguage()` 选语言），它同样会显示给用户看。

## 6. 样式、布局与主题（**先读这一节再写界面**）

这一节的每一条都对应一次真实事故（用户反馈 + 真机取证）。验收电池的 `layout.scan` 会按
「文件:行号」点名违反下面几条的地方；模板里的 `renderer/components/ui.tsx` 是**正确写法的样板**，
页面与组件直接复用它的原语，不要另外发明一套。

### 6.1 整页不出滚动条（页面层）

宿主给插件页面的高度是**确定的**：

```
custom-frame-outer(100vh) → custom-frame(h100%, overflow hidden, flex col)
  → frame-body(flex1, min-h0, overflow hidden)
    → .frame-body-center(flex1, overflow auto, min-h0)  ← 插件页面挂在这里
```

因此：

- 根节点用 `h-full` 撑满，**自己不滚**：`flex h-full min-h-0 w-full flex-col overflow-hidden`。
  **绝不能写 `overflow-auto`/`overflow-scroll` 配 `h-full`** —— 那会把标题、页签一起滚出窗口，
  用户看到的就是「整个应用的滚动条」；
- 头部/工具条 `shrink-0`，正文块 `min-h-0 flex-1`；
- 「内容比窗口多」**不要用滚动条解决**（插件页面也不该有滚动条）：用
  `FitTable`（按容器高度算行数）/ `FitList`（贪心塞行 + 「还有 N 项」）/ `ChartBox`（按容器尺寸重画）；
- 真要一根滚动条，只给某个内容块加 `min-h-0 flex-1 overflow-y-auto`（`PageShell` 的 `scroll` 就是这个）。

四条硬规则（1440×900 与 1200×660 × 六页签实测 0 溢出）：

1. **单行的 CSS grid 必须写 `grid-rows-1`**（隐式行是 auto，按内容算高会把网格顶破）；
2. **不要用 Tailwind 断点切栏数**（`xl:col-span-8` 在窄窗口退回单列 → 面板竖堆 → 必溢出）：
   列布局一律固定 `grid-cols-12` + `col-span-8/4`；
3. **自适应容器不要设「最小高度」**（`minHeight` 等于固定高度，会把面板顶破）；
4. **自适应表格别猜尺寸**：antd 的表头/行/分页器高度会随版本与字号变。用「量部件 → 一次算容量」
   （`FitTable` 就是这么写的），**不要**用「量余量 → 加/减一行」的收敛环。

### 6.2 弹窗（浮层）必须有高度上限

页面不出滚动条**还不够**：弹窗没有上限时，滚动容器会变成 `.ant-modal-wrap`
（`position: fixed; overflow: auto`，**铺满整个视口**）——窗口右边缘冒出「整页」滚动条，
滚的是整个对话框，标题与「保存」按钮一起被滚出视口。

- 表单弹窗一律展开 `formModalProps`（模板 `renderer/components/ui.tsx`）：头脚 `shrink-0`、
  正文 `flex:1 / minHeight:0 / overflow:auto`，**标题与按钮固定、正文自己滚**；
- 短弹窗展开 `createModalProps`（只把 antd 默认的 `top: 100px` 收到 24px）；
- **不要**给正文写死 `max-height: calc(100vh - Npx)`：头脚高度会随标题行数/字号/语言变，
  N 一旦算少滚动条就回来了；
- antd 6 的语义名是 **`container`**（`.ant-modal-container`，v5 叫 `content`/`.ant-modal-content`）：
  写 `styles.content` 会被 TS 直接拒绝（TS2353），在探针里查 `.ant-modal-content` 也查不到。

### 6.3 页签（antd 6 Tabs）撑满高度的正确写法

用模板的 `pageTabsProps`，别自己写 `styles`。两个坑：

1. 每个页签**各自是一个 `.ant-tabs-content`**（老的 `.ant-tabs-content-holder` 已不存在），
   而且 antd 会把**访问过的**页签都留在 DOM 里 → 给 `content` 写 `flex:1` 会让这些 pane
   **瓜分高度**（访问 6 个页签时当前页只剩 1/6 高）。正确：`content` = `position:absolute; inset:0`；
2. `content` 里**绝对不能写 `display`**：antd 靠 `.ant-tabs-content-hidden` 这个**类**隐藏非激活页签，
   内联样式优先级更高 → 隐藏失效 → 访问过的页签全部叠在一起同时画出来（症状「内容都挤在一堆」）。
   页签内部的列布局交给 `<Pane>`（`h-full` + 自己的 flex）。

### 6.4 主题（暗色）只能走 token 与 `useTheme()`

**不能用 Tailwind 的 `dark:` 变体**：工坊编 `plugin.css` 用的是 `tailwindcss/theme + utilities`
（没有 `@custom-variant dark`），`dark:` 落成的是 `@media (prefers-color-scheme: dark)`（跟**操作系统**
配色）；而宿主是靠 `document.documentElement` 上的 `.dark` 类 + antd `darkAlgorithm` 切主题的
（主题模式还有「跟随时间」的 auto，与系统配色无关）。两者对不上：应用暗色 + 系统亮色 = 插件仍画浅色。

- **中性色取 antd token**（`theme.useToken()`）：`colorBorderSecondary` / `colorSplit` /
  `colorFillQuaternary` / `colorFillSecondary` / `colorTextTertiary` / `colorText` / `colorBgContainer`；
- **语义色按主题给两份**：判暗色用宿主 `@host/renderer/hooks/useTheme` 的 `effectiveTheme`
  （与 antd 算法、`.dark` 类**同源**）。模板 `renderer/components/ui.tsx` 的 `usePluginPalette()`
  已经把亮/暗两套挑好了（亮色语义色按「文字压在面板底色上对比度 ≥ 3:1」收深过一档），**直接用**；
- **组件里不出现字面量色值**（用户数据的默认色除外，例如分类默认色）；
- 悬停/选中底色用**中性半透明**（`HOVER_BG = 'rgba(128,128,128,0.12)'`）：叠在主题底色上亮暗都成立，
  写死浅灰在暗色下就是一块亮斑；
- SVG 图表：网格 `stroke={p.split}`、轴文字 `fill={p.axis}`、端点圆心 `fill={p.surface}`、
  中心数字 `fill={p.text}`；
- 一个例外要记住：`DatePicker` / `ColorPicker` 这类**靠 ConfigProvider 主题上下文**渲染浮层的组件，
  直接用会拿到 antd 默认主题（不是宿主的）。要用它们就自己包一层
  `<ConfigProvider theme={{ algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>`。

### 6.5 表格单元格不得越出 `td`

有列写了 `ellipsis: true` → 表格变 `table-layout: fixed` → 没写 `width` 的列只分「剩余宽度」，
而 `td` 的 `overflow` 是 `visible` → 比列宽宽的内容**叠到隔壁列上**（不是被裁，是叠）。

- 单元格内容一律 `min-w-0` + `truncate` 兜底；**不要**出现 `shrink-0` 的固定宽度块；
- 要「宽窗一行、窄窗两行」就用 `useSize()` 量**单元格自己的宽度**再选排版
  （按列宽选 ⇒ 同列每行同高 ⇒ 自适应表格量到的行高对每行都成立）；
- 长文本列补 `ellipsis: true`。

### 6.6 设置页的观感（字段顺排）

设置页（`settingsSection`）与宿主的设置页放在一起看，所以：

- **一行一个字段**，标签在左、控件在右；**不要**装饰性分组标题（强调色圆点 + 发丝线 +「连接/模型」
  这类空标签），也**不要**带框的信息块 / 徽章面板 —— 分组标签只用纯文本；
- 结构只在**携带信息**时才成立（状态、计数、明细），而且信息该放进字段本身（placeholder / 说明文字），
  不要另加一块「当前值：…」的展示面板；
- 悬停/浮层要展示明细时给**结构化面板**（标题行 + 发丝线 + 左右对齐的键值明细），
  不要把信息拼成一行字符串。

### 6.7 样式产物本身

- 默认由工坊用 Tailwind（theme + utilities，**不含 preflight**）扫源码生成 `plugin.css` 并随包分发；
- 因此**类名必须是字面量**（`className="p-4 flex"` 可以，`className={'p-' + n}` 扫不到）；
- 宿主的 Tailwind 产物**不覆盖外部插件**：漏样式 = 界面变形，验收里的 `style.coverage` 会点名。

### 6.8 图标

- 渲染层 `import { RiXxx } from '@remixicon/react'` 的名字必须是宿主装的版本里**真实存在**的导出
  （名字写错 = 运行期 `undefined` → JSX 直接抛「Element type is invalid」白屏）；
- 清单 `plugin.json` 的 `menu.icon` 是**名字字符串**，只有宿主 `declared-icons` 表里的那几个能首帧正确显示，
  其它一律先回退成通用图标（不报错，真实注册后覆盖）→ **清单图标与 `renderer/plugin.tsx` 注册的同一枚**。

## 7. 冒烟用例（可选）

```js
export default {
  channels: {
    'plugin:${vars.id}:some-channel': {
      args: ['参数1', 2],
      expect: (value) => value?.ok === true || '失败原因'
    }
  },
  // 验收会真的读写用户库/设置：收尾把它们还原（$result:<通道>#<字段> 指向前面的返回值）
  cleanup: [
    { channel: 'plugin:${vars.id}:some-reset', args: ['$result:plugin:${vars.id}:some-get#value'] }
  ]
}
```

- `channels`：每条用真实 handler 调用一次，`expect` 返回 true = 通过、字符串 = 失败原因；
- `cleanup`：**无论前面的用例是否通过都会执行**。模板自带的冒烟会建一条记录、改一次设置，
  所以都带收尾——否则用户下次打开插件会看到 `smoke-item`，设置也被改成 false；
- 收尾失败同样算验收失败：「验一下就改了用户数据」不是可接受的行为。

## 8. 不要影响宿主运转（硬约束）

插件主进程代码跑在宿主进程里、渲染层代码跑在宿主页面里——「能做什么」不是一张权限表
能挡住的。因此下面几条既是**验收会判失败的**（`safety.scan`），也是运行期会被拦截/降级的：

- **不要 `process.exit()` / `process.abort()` / `process.kill(自己)`**：宿主会把它拦成一次
  可读错误（在 IPC handler 里就是这次调用失败，在 `install` 里就是插件装载失败）。
  应用的生命周期归宿主。发布前验收命中即 **FAIL**。
- **不要直接 `ipcMain.handle` / `ipcMain.on`**：通道一律经 `ctx.registerIpc` 注册，
  否则停用/卸载时摘不掉——一个插件就能在宿主里留下永远应答的通道。验收命中即 **FAIL**。
- **全局样式不许动宿主**：`html` / `body` / `#root` / `*` / `.custom-frame` / `.frame-*` /
  `.custom-scrollbar` / `.ant-app` / `.ant-*`（antd 全局组件）的规则会在注入前被**丢弃**，
  `:root` 只允许放 `--变量`。插件自己的样式写成类名（Tailwind 工具类，或带自己的前缀的类），
  只作用在自己的 DOM 上；要改 antd 组件就用 token 或 `ConfigProvider`，不要全局改类名。
- **`install` 里不做重活**：装载期只登记通道/贡献/路由；建表、读盘、起网络与定时器放进
  `ctx.effect`，并且返回的清理函数要真的停掉它们（停用插件后不该还有定时器在跑）。
- **后台循环要能被停掉、也要自己兜错**：`setInterval` 的回调里自己 `try/catch`（未捕获异常
  会以「插件崩溃」的样子冒到宿主日志）；间隔别小于 1s；批量查库要分页，不要一次
  `select *` 几十万行把主进程卡住。
- **只写自己的数据**：数据进自己的表（表名带插件前缀）、设置进
  `userData/plugin-state/${vars.id}.json`；绝不写用户工作区，也不删/改别的插件的表与文件。
- **AI 工具要有边界**：外部请求设超时、结果截断（工具输出会原样进对话），不要把整库数据
  一次返回给模型。

## 9. 做完之后

1. `plugin_build`：构建 + 静态审计（清单、宿主契约、体积）；
2. `plugin_verify`：跑完整验收电池（含真实装载 main.cjs 的冒烟与渲染层探针），报告逐项给结论；
   - 安装**之前**渲染层探针只能 SKIP（插件还没装/没启用），这是正常的；
   - **每次改完源码都要重新 verify**：只重新 build 不算。发布闸门按内容指纹核对，
     报告与产物都必须对应当前源码，否则安装会被拒绝；
3. `plugin_publish install`：装进 `userData/plugins/${vars.id}/` **立即启用**，界面马上出现
   （菜单/设置页）；装完会自动在真界面上复验一次（失败自动回滚卸载），并把结论写回最近一次验收报告。
   **升级**同一条命令：宿主会先 teardown 旧主模块、清掉 `require` 缓存，再装新代码，
   新通道与新界面一起当场生效——不需要让用户「完全退出并重新打开应用」。

被 `plugin_publish` 拒绝时，按它给的下一步做（通常就是重新 `plugin_verify`），
**不要重复同一个安装调用**——防循环护栏会把它判成原地打转。

插件停在「已安装·停用」时，用 `plugin_publish enable` 重新启用并当场复验
（复验失败会自动停用，不会留下一个开着的坏插件）。

### 交付前的自查清单（照着逐条过一遍，能省掉一整轮返工）

- [ ] **验收报告全绿**：`plugin_verify` 的致命项全过；`layout.scan` / `style.coverage` 没有点名；
- [ ] **界面在窗口内**：根节点没有 `overflow-auto`、头部与正文用 `shrink-0` / `min-h-0 flex-1` 分层，
      内容多了靠 `FitTable` / `FitList` 降级而不是滚动条（窄窗口 1200×660 也要看一眼）；
- [ ] **每个 Modal 都展开 `formModalProps` 或 `createModalProps`**，矮窗口下标题与按钮都点得到；
- [ ] **暗色主题**：切到暗色（设置 → 外观）后没有白底白字、没有比背景还亮的网格线，
      代码里搜不到 `dark:` 与字面量色值；
- [ ] **词条**：新增的文案都进 `locales/`（中英逐键对齐），界面上没有 `${vars.id}.xxx` 这样的原始键名；
- [ ] **不碰宿主生命周期**：没有 `process.exit` / `process.abort` / 直接 `ipcMain.*`
      （`safety.scan` 全过），通道都走 `ctx.registerIpc`；
- [ ] **样式不外溢**：`plugin.css` 里没有 `html` / `body` / `#root` / `*` / 宿主外壳类名 /
      `.ant-*`，`:root` 只有变量；
- [ ] **后台任务可停**：定时器/网络请求都在 `ctx.effect` 里，返回的清理函数真的停掉它们，
      回调自己 `try/catch`（停用插件后不该还有活着的定时器）；
- [ ] **`install` 可重复执行**：建表 `IF NOT EXISTS`、装载期没有「只做一次」的副作用——
      停用后重新启用、升级发布都会再装一遍（否则表现为升级后新通道/新功能要重启应用才生效）；
- [ ] **通道闭环**：渲染层用到的每个通道都在 `main/ipc.ts` 里注册、事件通道在 `main/index.ts` 里 `registerEvent`；
- [ ] **版本号**：改了代码就把 `plugin.json` 的 `version` 升一位（面板据此显示更新）；
- [ ] **数据与清理**：应用数据进自己的表、设置进 `plugin-state/`，`PLUGIN_PURGE` 的 `label` 写清「会删什么」。
