import * as fs from 'fs'
import * as path from 'path'

/**
 * 插件样式表（`plugin.css`）的生成与覆盖检查。
 *
 * 为什么需要这一块（2026-09-26 的事故，见 src/plugins/PACKAGING.md）：宿主自己的 Tailwind
 * 是**构建期**扫 `src/plugins/**`（内置插件）生成的，运行期才装进来的外部插件不在扫描范围里，
 * 于是外部插件用到的类名有近四成在宿主 CSS 里没有任何规则 —— 界面直接变形。
 * 契约因此是「插件自带 plugin.css」，工坊把它自动化成两步：
 *
 * 1. **生成**（`auto` 模式）：扫草稿源码里的类名，用 Tailwind 的 **JS 编译 API**
 *    （`tailwindcss` 包导出 `compile`，纯 JS，不依赖 oxide 原生扫描器）编出
 *    theme + utilities 两层、**不含 preflight** 的 CSS —— 手工做法的等价物；
 * 2. **检查**：把 `className` 位置用到的类名逐个到最终 CSS 里找规则，缺的名单进验收报告
 *    （`style.coverage`）。类名拼错、动态拼接扫不到，都在这里被点名。
 *
 * 两类候选要分开（血的教训）：
 * - **strict（className 位置）**：`className="p-4 flex"`、`className={cn('mt-2', x && 'hidden')}`
 *   —— 这些必须真的有规则，缺一条就是缺样式；
 * - **loose（其它字符串字面量）**：只用来**喂给 Tailwind 生成**（`const cls = 'flex p-2'` 这种
 *   间接写法要能编出来），**不参与覆盖判定** —— 否则 `useState`、`plugin:demo:state-get`
 *   这类字符串会被误报成缺失类名，把报告淹掉。
 */

/** Tailwind 入口：只取 theme + utilities 两层（不含 preflight，注入宿主文档才不会重置宿主样式） */
const TAILWIND_ENTRY =
  '@import "tailwindcss/theme" layer(theme);\n@import "tailwindcss/utilities" layer(utilities);\n'

/** Tailwind 已知的变体前缀（决定 `hover:bg-red-500` 这类候选是否可信） */
const VARIANT_PREFIXES = new Set([
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'visited',
  'disabled',
  'checked',
  'first',
  'last',
  'odd',
  'even',
  'group',
  'peer',
  'dark',
  'light',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
  'motion-safe',
  'motion-reduce',
  'print',
  'rtl',
  'ltr',
  'before',
  'after',
  'placeholder',
  'selection',
  'file',
  'open'
])

/** 单个候选的形状约束 */
const TOKEN_RE = /^[A-Za-z0-9!@%_:\-./[\]()#,>+~*=&$]+$/

/**
 * 候选是否「像 Tailwind 类名」。
 *
 * 这道筛子只服务生成（loose 候选）与最后的兜底过滤：
 * - 排除 URL / 路径 / 正则 / 中文 / 长句；
 * - 带 `:` 的必须是已知变体链（`plugin:demo:state-set` 这种通道名要被排除）。
 */
export function looksLikeClassName(token: string): boolean {
  if (token.length < 2 || token.length > 64) return false
  if (!TOKEN_RE.test(token)) return false
  if (/^https?:|^data:|^plugin:|^blob:|^file:/.test(token)) return false
  if (token.includes('//') || token.includes('\\')) return false
  const segments = token.split(':')
  if (segments.length > 1) {
    // 最后一段是工具类，前面每段都得是已知变体（可以是 hover:focus 这类组合）
    const prefixes = segments.slice(0, -1)
    if (!prefixes.every((p) => VARIANT_PREFIXES.has(p) || p === '')) return false
  }
  if (/^[A-Z]/.test(token)) return false // 组件名 / 类型名
  if (/^[a-z]+[A-Z]/.test(token)) return false // camelCase 标识符
  return true
}

/** 把一段类名文本切成候选（空白分隔，逐段过筛） */
function splitTokens(text: string, into: Set<string>): void {
  for (const token of text.split(/\s+/)) {
    if (looksLikeClassName(token)) into.add(token)
  }
}

/** 字符串字面量里的内容（生成用：间接写法也要能扫到） */
function literalContents(source: string): string[] {
  const out: string[] = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const body = match[2]
    if (body && body.length <= 400) out.push(body)
  }
  return out
}

/**
 * `className` / `class` 位置的字面量（覆盖判定用）。
 *
 * 三种形态都收：`className="a b"`、`className={'a b'}`、`className={cn('a', x && 'b')}`
 * —— 后者按括号配对取出整个表达式，再抽出其中的字符串字面量。
 */
function classNameExpressions(source: string): string[] {
  const out: string[] = []
  const attrRe = /\bclass(?:Name)?\s*=\s*/g
  while (attrRe.exec(source) !== null) {
    const index = attrRe.lastIndex
    const quote = source[index]
    if (quote === '"' || quote === "'") {
      const end = source.indexOf(quote, index + 1)
      if (end > 0) {
        out.push(source.slice(index + 1, end))
        attrRe.lastIndex = end + 1
      }
      continue
    }
    if (quote !== '{') continue
    // 括号配对取整个表达式（允许嵌套与模板字面量里的反引号）
    let depth = 0
    let cursor = index
    while (cursor < source.length) {
      const ch = source[cursor]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    const expr = source.slice(index + 1, cursor)
    for (const literal of literalContents(expr)) out.push(literal)
    attrRe.lastIndex = cursor + 1
  }
  return out
}

/** 从一份源码里抽出两类候选 */
export function extractCandidates(source: string): { strict: string[]; loose: string[] } {
  const strict = new Set<string>()
  const loose = new Set<string>()
  for (const expr of classNameExpressions(source)) splitTokens(expr, strict)
  for (const literal of literalContents(source)) splitTokens(literal, loose)
  // strict 的成员同时也是生成输入，因此从 loose 里去掉重复
  for (const token of strict) loose.delete(token)
  return { strict: [...strict], loose: [...loose] }
}

/** 扫草稿源码（renderer/**、main/** 的 ts/tsx/js/jsx/mjs/cjs/html），累加两类候选 */
export function scanDraftCandidates(draftDir: string): { strict: string[]; all: string[] } {
  const strict = new Set<string>()
  const loose = new Set<string>()
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
        walk(full, nextRel)
        continue
      }
      if (!/\.(tsx?|jsx?|mjs|cjs|html)$/.test(entry.name)) continue
      try {
        const found = extractCandidates(fs.readFileSync(full, 'utf-8'))
        for (const token of found.strict) strict.add(token)
        for (const token of found.loose) loose.add(token)
      } catch {
        // 读不到就跳过（不影响构建）
      }
    }
  }
  walk(draftDir, '')
  return { strict: [...strict], all: [...new Set([...strict, ...loose])] }
}

/** CSS 里的类名要转义（`w-[280px]` → `.w-\[280px\]`，`hover:scale-105` → `.hover\:scale-105`） */
export function cssEscapeClass(className: string): string {
  return className.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`)
}

/** CSS 里是否有该类的规则（用「转义选择器 + 非类名字符」判定，避免 `.flex` 命中 `.flex-1`） */
export function cssHasRule(css: string, className: string): boolean {
  const selector = `.${cssEscapeClass(className)}`
  let index = css.indexOf(selector)
  while (index >= 0) {
    const after = css[index + selector.length]
    if (after === undefined) return true
    if (!/[A-Za-z0-9_-]/.test(after)) return true
    index = css.indexOf(selector, index + 1)
  }
  return false
}

/** strict 候选里没有规则的类名（最多返回 limit 条，避免报告里塞几百个名字） */
export function missingClasses(css: string, strict: string[], limit = 24): string[] {
  const missing: string[] = []
  for (const candidate of [...strict].sort((a, b) => a.localeCompare(b, 'en'))) {
    if (cssHasRule(css, candidate)) continue
    missing.push(candidate)
    if (missing.length >= limit) break
  }
  return missing
}

/**
 * 模块加载器（由 service 注入）。
 *
 * 为什么注入而不是在本模块 `import`：构建要用 esbuild、样式要用 tailwindcss，
 * 两者都不该被静态打进插件包，且**离线工装要能用仓库里那一份**。
 * `resolve` 用于 Tailwind 内部的 `tailwindcss/theme` 这类子路径样式表。
 */
export interface ModuleLoader {
  require: (id: string) => unknown
  resolve: (id: string) => string
}

/** Tailwind 编译器句柄（延迟加载：装不上时报可读错误，由调用方降级） */
type TailwindCompiler = { build: (candidates: string[]) => string }

/**
 * 用 Tailwind 的 JS API 编译插件样式表。
 *
 * 关键点：**候选由我们自己给**（`build(candidates)`），因此完全不触发 Tailwind 的文件扫描
 * —— `@tailwindcss/oxide`（原生模块）在打包后的应用里未必可用，而这条路径不需要它。
 */
export async function compilePluginCss(
  candidates: string[],
  loader: ModuleLoader,
  baseDir: string
): Promise<string> {
  if (candidates.length === 0) return ''
  const tailwind = loader.require('tailwindcss') as {
    compile?: (
      css: string,
      opts: {
        base: string
        loadStylesheet: (
          id: string,
          base: string
        ) => Promise<{ path: string; base: string; content: string }>
        loadModule?: (id: string, base: string) => Promise<{ base: string; module: unknown }>
      }
    ) => Promise<TailwindCompiler>
  }
  if (!tailwind || typeof tailwind.compile !== 'function') {
    throw new Error('tailwindcss 的 JS 编译 API 不可用（compile 缺失）')
  }

  const compiler = await tailwind.compile(TAILWIND_ENTRY, {
    base: baseDir,
    loadStylesheet: async (id) => {
      const resolved = resolveTailwindCss(id, loader)
      return {
        path: resolved,
        base: path.dirname(resolved),
        content: fs.readFileSync(resolved, 'utf-8')
      }
    },
    loadModule: async (id) => ({ base: baseDir, module: loader.require(id) })
  })
  return compiler.build(candidates)
}

/** 解析 Tailwind 内部的样式表导入（`tailwindcss/theme`、`tailwindcss/utilities`） */
function resolveTailwindCss(id: string, loader: ModuleLoader): string {
  for (const candidate of [id, `${id}/index.css`, `${id}.css`]) {
    try {
      return loader.resolve(candidate)
    } catch {
      // 换下一个候选
    }
  }
  throw new Error(`找不到 Tailwind 内部样式表：${id}`)
}
