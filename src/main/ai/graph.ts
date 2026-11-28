/**
 * Self-contained graph execution engine.
 *
 * The project only needs a minimal subset: "single state + conditional edges":
 *   START → model → (has tool calls ? tools : END) → model …
 * So only the following are implemented:
 * - `Annotation` / `Annotation.Root`: declare state channels (optionally with a reducer / default);
 * - `StateGraph`: addNode / addEdge / addConditionalEdges / compile;
 * - the compiled artifact: `invoke` (returns the final state) and `stream` (`streamMode: ['messages']`
 *   — emits incremental chunks produced by model calls inside nodes as `[mode, [chunk, metadata]]`);
 * - `GraphRecursionError`: thrown when the step limit is exceeded (the upper layer wraps up
 *   gracefully instead of failing the whole turn).
 *
 * One deliberate difference from a full framework implementation: incremental chunks from
 * subgraphs (agent graphs run by the task tool) do **not** bubble up to the main graph stream —
 * the sub-agent turns the chunks into `sub_*` records itself; the main graph therefore doesn't need
 * a "filter subgraphs by checkpoint ns" patch.
 */

/** Graph entry marker */
export const START = '__start__'
/** Graph end marker */
export const END = '__end__'

/** Recursion step limit exceeded (the name is kept for compatibility; the upper layer checks both `instanceof` and `name`) */
export class GraphRecursionError extends Error {
  constructor(message = 'Recursion limit reached') {
    super(message)
    this.name = 'GraphRecursionError'
  }
}

/** Overwrite an entire channel (the type name is kept for upper-layer type signatures) */
export interface OverwriteValue<T> {
  readonly __overwrite: T
}

/** State channel declaration */
export interface AnnotationDefinition<T> {
  /** How multiple writes to the same channel are merged (overwrite by default); declared as a method signature to keep the parameter bivariant (for state type inference) */
  reducer?(left: T, right: T): T
  /** Initial value factory (used when the input doesn't provide the field) */
  default?(): T
}

/** Create a channel declaration (`Annotation<T>({...})`) */
function createAnnotation<T>(options?: AnnotationDefinition<T>): AnnotationDefinition<T> {
  return options ?? {}
}

type AnnotationMap = Record<string, AnnotationDefinition<unknown>>

/** Return value of `Annotation.Root(...)`: the channel table (also carrying the state type) */
export interface AnnotationRoot<S> {
  readonly channels: { readonly [K in keyof S]: AnnotationDefinition<S[K]> }
}

type StateFromAnnotations<M extends AnnotationMap> = {
  [K in keyof M]: M[K] extends AnnotationDefinition<infer T> ? T : never
}

/**
 * State declaration entry point.
 * Usage: `const AgentState = Annotation.Root({ messages: Annotation<BaseMessage[]>({...}) })`
 */
export const Annotation = Object.assign(createAnnotation, {
  Root<M extends AnnotationMap>(map: M): AnnotationRoot<StateFromAnnotations<M>> {
    return { channels: map as unknown as AnnotationRoot<StateFromAnnotations<M>>['channels'] }
  }
})

/** State object treated as immutable (node return values are merged per channel reducer) */
type StateUpdate<S> = Partial<S> | void

/** Node function */
export type GraphNodeFn<S> = (
  state: S,
  config: GraphNodeConfig
) => StateUpdate<S> | Promise<StateUpdate<S>>

/** Conditional edge routing: returns the next node name or END */
export type GraphRouter<S> = (state: S) => string

/** Node execution config (also passed through as the model call config) */
export type GraphNodeConfig = {
  signal?: AbortSignal
  configurable: Record<string, unknown>
  /** Model chunk outlet (injected by graph.stream; not provided for invoke) */
  onModelChunk?: (chunk: unknown) => void
  /** Current graph execution id (for logging / troubleshooting) */
  runId?: string
  [key: string]: unknown
}

/** Compatible with the old type name (used by the node signatures in agent.ts) */
export type LangGraphRunnableConfig = GraphNodeConfig

/** Graph execution options */
export interface GraphRunOptions {
  /** Maximum node execution steps (default 25) */
  recursionLimit?: number
  signal?: AbortSignal
  /** Runtime config passed through to nodes / tools (topicId, turnSource, etc.) */
  configurable?: Record<string, unknown>
}

/** Streaming options: only messages mode is supported (the only mode the project uses) */
export interface GraphStreamOptions extends GraphRunOptions {
  streamMode?: 'messages' | Array<'messages'>
}

/** Compiled graph */
export interface CompiledStateGraph<
  State = Record<string, unknown>,
  Update = Partial<State>,
  Nodes extends string = string
> {
  /** Union type of node names (type-level marker; doesn't exist at runtime) */
  readonly __nodes?: Nodes
  invoke(input: Update, options?: GraphRunOptions): Promise<State>
  stream(
    input: Update,
    options: GraphStreamOptions
  ): AsyncIterable<[string, [unknown, Record<string, unknown>]]>
}

/** One streaming event: `[mode, [chunk, metadata]]` */
export type GraphStreamEvent = [string, [unknown, Record<string, unknown>]]

/** Simple async queue: run the graph in the background and consume events in the foreground */
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

/** Cancellation error (keeps name=AbortError so the upper layer can finish silently) */
function abortError(): Error {
  const error = new Error('Graph execution aborted')
  error.name = 'AbortError'
  return error
}

/** Graph definition */
export class StateGraph<S extends Record<string, unknown>> {
  private readonly channels: { readonly [K in keyof S]: AnnotationDefinition<S[K]> }
  private readonly nodes = new Map<string, GraphNodeFn<S>>()
  private readonly edges = new Map<string, string>()
  private readonly conditionalEdges = new Map<string, GraphRouter<S>>()
  private startNode?: string

  constructor(annotation: AnnotationRoot<S>) {
    this.channels = annotation.channels
  }

  /** Register a node */
  addNode<K extends string>(name: K, fn: GraphNodeFn<S>): this {
    if (this.nodes.has(name)) throw new Error(`Node "${name}" is already registered`)
    this.nodes.set(name, fn)
    return this
  }

  /** Register a fixed edge (from can be START) */
  addEdge(from: string, to: string): this {
    if (from === START) {
      this.startNode = to
      return this
    }
    this.edges.set(from, to)
    return this
  }

  /** Register a conditional edge (the router returns the next node name or END) */
  addConditionalEdges(from: string, router: GraphRouter<S>): this {
    this.conditionalEdges.set(from, router)
    return this
  }

  /** Compile: validate the graph structure and return an executable graph */
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

/** Compiled artifact implementation */
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

  /** Initialize state from channel defaults + input */
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

  /** Merge node return values (use the reducer when present, otherwise overwrite; skip undefined) */
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

  /** Compute the next node (return END when there is none) */
  private nextNode(current: string, state: S): string {
    const fixed = this.edges.get(current)
    if (fixed) return fixed
    const router = this.conditionalEdges.get(current)
    if (router) return router(state)
    return END
  }

  /** Run one step + guard the recursion limit */
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
                  // Keep the namespace shape (the main graph's model node names start with "model:")
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
