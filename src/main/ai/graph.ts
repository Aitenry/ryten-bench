/**
 * 自研图执行引擎（替代 `@langchain/langgraph`）。
 *
 * 项目里只用到「单状态 + 条件边」的极简子集：
 *   START → model → (有工具调用 ? tools : END) → model …
 * 因此这里只实现：
 * - `Annotation` / `Annotation.Root`：声明状态通道（可带 reducer / 默认值）；
 * - `StateGraph`：addNode / addEdge / addConditionalEdges / compile；
 * - 编译产物：`invoke`（返回最终状态）与 `stream`（`streamMode: ['messages']`
 *   ——把节点内模型调用产生的增量块按 `[mode, [chunk, metadata]]` 推出来）；
 * - `GraphRecursionError`：步数超限时抛出（上层据此优雅收尾，而不是把整轮判失败）。
 *
 * 与框架版的一处刻意差异：子图（task 工具里跑的代理图）的增量块**不会**冒泡到主图流——
 * 子代理自己把块转成 `sub_*` 记录；主图因此不需要「按 checkpoint ns 过滤子图」的补丁。
 */

/** 图起点标记 */
export const START = '__start__'
/** 图终点标记 */
export const END = '__end__'

/** 递归步数超限（名字保持旧实现，上层有 `instanceof` 与 `name` 双重判断） */
export class GraphRecursionError extends Error {
  constructor(message = 'Recursion limit reached') {
    super(message)
    this.name = 'GraphRecursionError'
  }
}

/** 整体覆盖某通道（保留旧类型名，供上层类型签名使用） */
export interface OverwriteValue<T> {
  readonly __overwrite: T
}

/** 状态通道声明 */
export interface AnnotationDefinition<T> {
  /** 同一通道多次写入时的合并方式（缺省为覆盖）；用方法签名以保持参数双变（便于推导状态类型） */
  reducer?(left: T, right: T): T
  /** 初始值工厂（输入未提供该字段时使用） */
  default?(): T
}

/** 创建通道声明（`Annotation<T>({...})`） */
function createAnnotation<T>(options?: AnnotationDefinition<T>): AnnotationDefinition<T> {
  return options ?? {}
}

type AnnotationMap = Record<string, AnnotationDefinition<unknown>>

/** `Annotation.Root(...)` 的返回值：通道表（同时携带状态类型） */
export interface AnnotationRoot<S> {
  readonly channels: { readonly [K in keyof S]: AnnotationDefinition<S[K]> }
}

type StateFromAnnotations<M extends AnnotationMap> = {
  [K in keyof M]: M[K] extends AnnotationDefinition<infer T> ? T : never
}

/**
 * 状态声明入口。
 * 用法：`const AgentState = Annotation.Root({ messages: Annotation<BaseMessage[]>({...}) })`
 */
export const Annotation = Object.assign(createAnnotation, {
  Root<M extends AnnotationMap>(map: M): AnnotationRoot<StateFromAnnotations<M>> {
    return { channels: map as unknown as AnnotationRoot<StateFromAnnotations<M>>['channels'] }
  }
})

/** 视为不变的状态对象（节点返回值按通道 reducer 合并） */
type StateUpdate<S> = Partial<S> | void

/** 节点函数 */
export type GraphNodeFn<S> = (
  state: S,
  config: GraphNodeConfig
) => StateUpdate<S> | Promise<StateUpdate<S>>

/** 条件边路由：返回下一个节点名或 END */
export type GraphRouter<S> = (state: S) => string

/** 节点执行配置（同时作为模型调用的透传配置） */
export type GraphNodeConfig = {
  signal?: AbortSignal
  configurable: Record<string, unknown>
  /** 模型增量块出口（由 graph.stream 注入；invoke 时不提供） */
  onModelChunk?: (chunk: unknown) => void
  /** 当前图执行标识（日志 / 排查用） */
  runId?: string
  [key: string]: unknown
}

/** 兼容旧类型名（agent.ts 的节点签名使用） */
export type LangGraphRunnableConfig = GraphNodeConfig

/** 图执行选项 */
export interface GraphRunOptions {
  /** 最大节点执行步数（缺省 25） */
  recursionLimit?: number
  signal?: AbortSignal
  /** 透传给节点 / 工具的运行期配置（topicId、turnSource 等） */
  configurable?: Record<string, unknown>
}

/** 流式选项：只支持 messages 模式（项目唯一用到的模式） */
export interface GraphStreamOptions extends GraphRunOptions {
  streamMode?: 'messages' | Array<'messages'>
}

/** 编译后的图 */
export interface CompiledStateGraph<
  State = Record<string, unknown>,
  Update = Partial<State>,
  Nodes extends string = string
> {
  /** 节点名联合类型（类型层标记，运行期不存在） */
  readonly __nodes?: Nodes
  invoke(input: Update, options?: GraphRunOptions): Promise<State>
  stream(
    input: Update,
    options: GraphStreamOptions
  ): AsyncIterable<[string, [unknown, Record<string, unknown>]]>
}

/** 一条流式事件：`[mode, [chunk, metadata]]`（与旧实现同形） */
export type GraphStreamEvent = [string, [unknown, Record<string, unknown>]]

/** 简易异步队列：后台执行图、前台消费事件 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<() => void> = []
  private closed = false
  private error?: Error

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.waiters.shift()?.()
  }

  close(error?: Error): void {
    if (error) this.error = error
    this.closed = true
    while (this.waiters.length > 0) this.waiters.shift()?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T
        continue
      }
      if (this.closed) {
        if (this.error) throw this.error
        return
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }
}

/** 取消错误（保持 name=AbortError，上层静默收尾） */
function abortError(): Error {
  const error = new Error('Graph execution aborted')
  error.name = 'AbortError'
  return error
}

/** 图定义 */
export class StateGraph<S extends Record<string, unknown>> {
  private readonly channels: { readonly [K in keyof S]: AnnotationDefinition<S[K]> }
  private readonly nodes = new Map<string, GraphNodeFn<S>>()
  private readonly edges = new Map<string, string>()
  private readonly conditionalEdges = new Map<string, GraphRouter<S>>()
  private startNode?: string

  constructor(annotation: AnnotationRoot<S>) {
    this.channels = annotation.channels
  }

  /** 注册节点 */
  addNode<K extends string>(name: K, fn: GraphNodeFn<S>): this {
    if (this.nodes.has(name)) throw new Error(`Node "${name}" is already registered`)
    this.nodes.set(name, fn)
    return this
  }

  /** 注册固定边（from 可为 START） */
  addEdge(from: string, to: string): this {
    if (from === START) {
      this.startNode = to
      return this
    }
    this.edges.set(from, to)
    return this
  }

  /** 注册条件边（路由函数返回下个节点名或 END） */
  addConditionalEdges(from: string, router: GraphRouter<S>): this {
    this.conditionalEdges.set(from, router)
    return this
  }

  /** 编译：校验图结构后返回可执行图 */
  compile(): CompiledStateGraph<S, Partial<S>, string> {
    const startNode = this.startNode
    if (!startNode) throw new Error('Graph has no entry point: call addEdge(START, "<node>") first')
    if (!this.nodes.has(startNode)) throw new Error(`Entry node "${startNode}" is not registered`)
    for (const [from, to] of this.edges) {
      if (from !== START && !this.nodes.has(from)) {
        throw new Error(`Edge source "${from}" is not registered`)
      }
      if (to !== END && !this.nodes.has(to)) {
        throw new Error(`Edge target "${to}" is not registered`)
      }
    }
    for (const from of this.conditionalEdges.keys()) {
      if (!this.nodes.has(from))
        throw new Error(`Conditional edge source "${from}" is not registered`)
    }
    return new CompiledGraph<S>(
      this.channels,
      this.nodes,
      this.edges,
      this.conditionalEdges,
      startNode
    )
  }
}

/** 编译产物实现 */
class CompiledGraph<S extends Record<string, unknown>> implements CompiledStateGraph<
  S,
  Partial<S>,
  string
> {
  constructor(
    private readonly channels: { readonly [K in keyof S]: AnnotationDefinition<S[K]> },
    private readonly nodes: Map<string, GraphNodeFn<S>>,
    private readonly edges: Map<string, string>,
    private readonly conditionalEdges: Map<string, GraphRouter<S>>,
    private readonly startNode: string
  ) {}

  /** 按通道默认值 + 输入初始化状态 */
  private initialize(input: Partial<S>): S {
    const state = {} as S
    for (const key of Object.keys(this.channels) as Array<keyof S>) {
      const channel = this.channels[key]
      const provided = input?.[key]
      if (provided !== undefined) {
        state[key] = provided
      } else if (channel.default) {
        state[key] = channel.default()
      }
    }
    return state
  }

  /** 合并节点返回值（有 reducer 走 reducer，否则覆盖；undefined 跳过） */
  private applyUpdate(state: S, update: StateUpdate<S>): void {
    if (!update) return
    for (const key of Object.keys(update) as Array<keyof S>) {
      const value = update[key]
      if (value === undefined) continue
      const channel = this.channels[key]
      if (!channel) {
        state[key] = value as S[keyof S]
        continue
      }
      if (channel.reducer && state[key] !== undefined) {
        state[key] = channel.reducer(state[key], value as S[keyof S])
      } else {
        state[key] = value as S[keyof S]
      }
    }
  }

  /** 计算下一个节点（不存在则返回 END） */
  private nextNode(current: string, state: S): string {
    const fixed = this.edges.get(current)
    if (fixed) return fixed
    const router = this.conditionalEdges.get(current)
    if (router) return router(state)
    return END
  }

  /** 单步执行 + 递归上限守卫 */
  private async runStep(
    nodeName: string,
    state: S,
    steps: number,
    limit: number,
    config: GraphNodeConfig
  ): Promise<string> {
    if (steps > limit) {
      throw new GraphRecursionError(
        `Recursion limit of ${limit} reached without hitting a stop condition. ` +
          'Increase the recursion limit or make the graph terminate earlier.'
      )
    }
    if (config.signal?.aborted) throw abortError()
    const node = this.nodes.get(nodeName)
    if (!node) throw new Error(`Node "${nodeName}" is not registered`)
    const update = await node(state, config)
    this.applyUpdate(state, update)
    return this.nextNode(nodeName, state)
  }

  async invoke(input: Partial<S>, options?: GraphRunOptions): Promise<S> {
    const state = this.initialize(input)
    const limit = options?.recursionLimit ?? 25
    const config: GraphNodeConfig = {
      signal: options?.signal,
      configurable: { ...(options?.configurable ?? {}) }
    }
    let current = this.startNode
    let steps = 0
    for (;;) {
      steps += 1
      current = await this.runStep(current, state, steps, limit, config)
      if (current === END) return state
    }
  }

  stream(
    input: Partial<S>,
    options: GraphStreamOptions
  ): AsyncIterable<[string, [unknown, Record<string, unknown>]]> {
    const queue = new AsyncEventQueue<[string, [unknown, Record<string, unknown>]]>()
    const state = this.initialize(input)
    const limit = options?.recursionLimit ?? 25
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    const execute = async (): Promise<void> => {
      let current = this.startNode
      let steps = 0
      for (;;) {
        steps += 1
        const nodeName = current
        const config: GraphNodeConfig = {
          signal: options?.signal,
          configurable: { ...(options?.configurable ?? {}) },
          runId,
          onModelChunk: (chunk) => {
            queue.push([
              'messages',
              [
                chunk,
                {
                  langgraph_node: nodeName,
                  // 保持旧实现的命名空间形状（主图 model 节点以 "model:" 开头）
                  langgraph_checkpoint_ns: `${nodeName}:${runId}`
                }
              ]
            ])
          }
        }
        current = await this.runStep(nodeName, state, steps, limit, config)
        if (current === END) return
      }
    }

    void execute().then(
      () => queue.close(),
      (err) => queue.close(err instanceof Error ? err : new Error(String(err)))
    )
    return queue
  }
}
