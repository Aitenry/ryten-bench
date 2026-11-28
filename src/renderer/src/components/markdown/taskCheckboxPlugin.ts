import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

/**
 * Custom task list parsing plugin.
 *
 * Marking only the li/ul is not enough: when a plain list and a task list are
 * adjacent, markdown-it merges them into a single <ul> with mixed items.
 * ProseMirror's taskList node only accepts taskItem children, so mixed items get
 * wrapped and regrouped, producing empty task items and content drift.
 *
 * This plugin splits mixed lists into separate <ul> elements at the token level:
 * - Task items: a leading "[ ] "/"[x] " becomes a checkbox; the li gets the task-list-item class
 * - Task list ul elements get the contains-task-list class (so tiptap-markdown's
 *   updateDOM maps them to taskList nodes)
 */
export function taskCheckboxPlugin(md: MarkdownIt): void {
  /* Checkbox rendering */
  md.renderer.rules.task_checkbox = (tokens, idx) => {
    const checked = tokens[idx].attrGet('checked') === 'true'
    return `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked=""' : ''}>`
  }

  md.core.ruler.after('inline', 'task-list-items', (state) => {
    const TokenCtor = state.Token as new (type: string, tag: string, nesting: number) => Token

    const cloneToken = (t: Token): Token => {
      const c = new TokenCtor(t.type, t.tag, t.nesting)
      c.level = t.level
      c.map = t.map
      c.attrs = t.attrs ? t.attrs.map((a) => a.slice()) : null
      c.block = t.block
      c.hidden = t.hidden
      c.meta = t.meta
      c.content = t.content
      c.children = t.children
      return c
    }

    const addClass = (tok: Token, cls: string): void => {
      const idx = tok.attrIndex('class')
      if (idx < 0) {
        tok.attrPush(['class', cls])
      } else if (tok.attrs && !tok.attrs[idx][1].split(/\s+/).includes(cls)) {
        tok.attrs[idx][1] = `${tok.attrs[idx][1]} ${cls}`
      }
    }

    const isTaskStart = (content: string): boolean =>
      content.startsWith('[ ] ') ||
      content.startsWith('[x] ') ||
      content.startsWith('[X] ') ||
      content === '[ ]' ||
      content === '[x]' ||
      content === '[X]'

    /* Convert the first inline content of a task item into a checkbox */
    const transformTaskItem = (itemTokens: Token[], level: number): Token[] => {
      for (const tok of itemTokens) {
        if (tok.type === 'list_item_open' && tok.level === level + 1) {
          addClass(tok, 'task-list-item')
          continue
        }
        if (tok.type === 'inline' && isTaskStart(tok.content)) {
          const checked =
            tok.content.startsWith('[x] ') ||
            tok.content.startsWith('[X] ') ||
            tok.content === '[x]' ||
            tok.content === '[X]'
          const checkbox = new TokenCtor('task_checkbox', '', 0)
          checkbox.attrSet('checked', checked ? 'true' : 'false')
          if (tok.children) {
            tok.children.unshift(checkbox)
            if (tok.children.length > 1 && tok.children[1].type === 'text') {
              tok.children[1].content = tok.children[1].content.slice(3)
            }
          }
          tok.content = tok.content.slice(3)
          break
        }
      }
      return itemTokens
    }

    /* Determine whether a list item is a task item (first inline starts with [ ] /[x]) */
    const classifyItem = (itemTokens: Token[]): 'task' | 'plain' => {
      const inline = itemTokens.find((t) => t.type === 'inline')
      if (inline && isTaskStart(inline.content)) return 'task'
      return 'plain'
    }

    /* When splitting mixed lists, drop paragraph wrappers that contain only a single inline,
       so that a compact list is not parsed as loose by markdown-it and drifts on round-trip */
    const stripParagraphs = (tokens: Token[], level: number): Token[] => {
      const out: Token[] = []
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.type === 'paragraph_open' && t.level === level + 2) {
          let j = i + 1
          const inner: Token[] = []
          while (j < tokens.length) {
            if (tokens[j].type === 'paragraph_close' && tokens[j].level === level + 2) break
            inner.push(tokens[j])
            j++
          }
          const inlineCount = inner.filter((x) => x.type === 'inline').length
          if (inlineCount === 1 && inner.length === 1) {
            out.push(...inner)
            i = j /* skip paragraph_close */
          } else {
            out.push(t)
          }
        } else {
          out.push(t)
        }
      }
      return out
    }

    /* Recursively process every bullet_list in the token array (including nested ones) and
       return the rebuilt array */
    const processTokens = (arr: Token[]): Token[] => {
      const out: Token[] = []
      let i = 0
      while (i < arr.length) {
        const t = arr[i]
        if (t.type === 'bullet_list_open') {
          const rebuilt = rebuildList(arr, i)
          out.push(...rebuilt.tokens)
          i = rebuilt.end
        } else {
          out.push(t)
          i++
        }
      }
      return out
    }

    /* Rebuild a single bullet_list: split it into separate ul elements by task/plain type */
    const rebuildList = (arr: Token[], openIdx: number): { tokens: Token[]; end: number } => {
      const openTok = arr[openIdx]
      const level = openTok.level
      let closeTok: Token | null = null
      let i = openIdx + 1

      const runs: { kind: 'task' | 'plain' | null; tokens: Token[] }[] = []
      let currentKind: 'task' | 'plain' | null = null
      let currentRun: Token[] = []

      const flush = (): void => {
        if (currentRun.length > 0) {
          runs.push({ kind: currentKind, tokens: currentRun })
          currentRun = []
        }
      }

      while (i < arr.length) {
        const t = arr[i]
        if (t.type === 'bullet_list_close' && t.level === level) {
          closeTok = t
          flush()
          i++
          break
        }
        if (t.type === 'list_item_open' && t.level === level + 1) {
          /* Consume the complete list item (up to the same-level list_item_close) */
          const itemTokens: Token[] = []
          let depth = 0
          while (i < arr.length) {
            const s = arr[i]
            itemTokens.push(s)
            if (s.type === 'list_item_open' && s.level === level + 1) depth++
            if (s.type === 'list_item_close' && s.level === level + 1) {
              depth--
              if (depth === 0) {
                i++
                break
              }
            }
            i++
          }
          /* Recursively process nested lists inside the item */
          const processed = processTokens(itemTokens)
          const kind = classifyItem(processed)
          if (kind !== currentKind) {
            flush()
            currentKind = kind
          }
          currentRun.push(...processed)
        } else {
          currentRun.push(t)
          i++
        }
      }

      const out: Token[] = []
      const wasSplit = runs.length > 1
      for (const run of runs) {
        const openClone = cloneToken(openTok)
        const runTokens = wasSplit ? stripParagraphs(run.tokens, level) : run.tokens
        if (run.kind === 'task') {
          addClass(openClone, 'contains-task-list')
          for (const itemTokens of splitItems(runTokens, level)) {
            transformTaskItem(itemTokens, level)
          }
        }
        out.push(openClone, ...runTokens, cloneToken(closeTok as Token))
      }
      return { tokens: out, end: i }
    }

    /* Split a run's tokens at list_item boundaries (one group per item) */
    const splitItems = (tokens: Token[], level: number): Token[][] => {
      const groups: Token[][] = []
      let current: Token[] = []
      let depth = 0
      for (const t of tokens) {
        current.push(t)
        if (t.type === 'list_item_open' && t.level === level + 1) depth++
        if (t.type === 'list_item_close' && t.level === level + 1) {
          depth--
          if (depth === 0) {
            groups.push(current)
            current = []
          }
        }
      }
      return groups
    }

    state.tokens = processTokens(state.tokens)
  })
}
