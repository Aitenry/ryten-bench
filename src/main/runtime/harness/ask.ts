import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import logger from 'electron-log'
import { mainFormat } from '../../i18n'
import { getFsToolTexts } from '../../i18n/tool-results-fs'

/**
 * 向用户提问（ask_user_question）— 对应 deepseek-harness 的
 * dsh-user-questions / dsh-tool-ask-user 体系
 *
 * 机制（参考 DSH，适配 RytenBench）：
 * - 工具执行期间向人类提问：工具节点挂起等待（图保持在 tools 节点），
 *   答案经 IPC 由前端弹窗收集后回写，模型拿到答案继续原循环（不消耗额外轮次）；
 * - 显式无超时（DSH 语义）：仅随本轮取消信号中止（ASK_ABORTED），
 *   流取消时挂起提问全部拒绝；
 * - 只有主代理持有该工具（子代理被禁问，对应 DELEGATED_CALLER 边界；
 *   v1 简化：子代理不持有 ask 工具）。
 */

/** 选项 */
export interface AskOption {
  label: string
  description?: string
  /** 分组键（如供应商类型 'openai'），前端用于树形目录分组展示 */
  group?: string
}

/** 单个问题 */
export interface AskQuestion {
  id: string
  question: string
  header?: string
  options?: AskOption[]
  multi_select?: boolean
  /** 题目种类（如 'model-recovery'=模型请求失败的「换模型继续」选择；普通提问无此字段） */
  kind?: string
  /** kind='model-recovery' 时的失败原因（展示用） */
  error?: string
  /** kind='model-recovery' 时「放弃继续」选项的文案（前端排到列表末尾并按放弃处理） */
  abandonLabel?: string
}

/** 答案（单选取第一个；多选为数组；带 custom 为补充文本） */
export interface AskAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/** 挂起提问的视图（广播到前端） */
export interface PendingQuestionView {
  topicId: number
  requestId: string
  questions: AskQuestion[]
}

interface PendingRecord extends PendingQuestionView {
  resolve: (answer: AskAnswer) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  /** signal 的中止处理器（解决/中止后用于移除监听，防闭包滞留） */
  onAbort?: () => void
}

export type AskListener = (pending: PendingQuestionView) => void

/** 提问服务（进程级单例：挂起队列 + IPC 答案回写） */
export class QuestionService {
  private readonly pending = new Map<string, PendingRecord>()

  /** 新提问广播回调（主进程注入，通知前端弹窗） */
  onAsk?: AskListener

  /**
   * 挂起等待用户回答。
   * signal 中止 → 抛 ASK_ABORTED（工具层捕获后返回取消文案）。
   */
  ask(topicId: number, questions: AskQuestion[], signal?: AbortSignal): Promise<AskAnswer> {
    const tr = getFsToolTexts()
    return new Promise<AskAnswer>((resolve, reject) => {
      const requestId = `q-${randomUUID()}`
      const onAbort = (): void => {
        this.pending.delete(requestId)
        const err = new Error(tr.ask.aborted)
        err.name = 'AskAbortedError'
        reject(err)
      }
      const record: PendingRecord = { topicId, requestId, questions, resolve, reject, signal }
      record.onAbort = onAbort
      this.pending.set(requestId, record)
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        // 只广播可序列化视图：PendingRecord 含 resolve/reject/signal，
        // 直接过 webContents.send 会抛 "Failed to serialize arguments"（Electron 结构化克隆）
        this.onAsk?.({
          topicId: record.topicId,
          requestId: record.requestId,
          questions: record.questions
        })
      } catch (err) {
        // 广播失败（序列化异常/无窗口）：清理挂起记录与信号监听，避免泄漏与永久挂起
        this.pending.delete(requestId)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      logger.info(`[Ask] 挂起提问 requestId=${requestId}（${questions.length} 个问题）`)
    })
  }

  /** 清理挂起记录的信号监听（修复：解决后监听器仍挂在 signal 上直至其触发/GC） */
  private detach(record: PendingRecord): void {
    if (record.signal && record.onAbort) {
      record.signal.removeEventListener('abort', record.onAbort)
    }
  }

  /** 用户回答：命中挂起提问则回写答案；不存在返回 false */
  answer(requestId: string, answers: AskAnswer['answers']): boolean {
    const record = this.pending.get(requestId)
    if (!record) return false
    this.pending.delete(requestId)
    this.detach(record)
    record.resolve({ answers })
    logger.info(`[Ask] 提问 ${requestId} 已回答（${answers.length} 项）`)
    return true
  }

  /** 读取话题的挂起提问（前端重载/恢复用） */
  getPending(topicId: number): PendingQuestionView | null {
    for (const record of this.pending.values()) {
      if (record.topicId === topicId) {
        return { topicId: record.topicId, requestId: record.requestId, questions: record.questions }
      }
    }
    return null
  }

  /** 话题全部挂起提问中止（流取消时调用） */
  abortTopic(topicId: number): void {
    const tr = getFsToolTexts()
    for (const [id, record] of this.pending) {
      if (record.topicId !== topicId) continue
      this.pending.delete(id)
      this.detach(record)
      const err = new Error(tr.ask.aborted)
      err.name = 'AskAbortedError'
      record.reject(err)
    }
  }

  /** 全部挂起提问中止（应用级取消兜底） */
  abortAll(): void {
    const tr = getFsToolTexts()
    for (const [id, record] of this.pending) {
      this.pending.delete(id)
      this.detach(record)
      const err = new Error(tr.ask.aborted)
      err.name = 'AskAbortedError'
      record.reject(err)
    }
  }
}

/** 进程级单例 */
export const questionService = new QuestionService()

const askOptionSchema = z.object({
  label: z.string().describe('Option text shown to the user'),
  description: z.string().optional().describe('One-sentence explanation of the option')
})

const askQuestionSchema = z.object({
  id: z.string().describe('Stable question id (echoed back verbatim in the answer)'),
  question: z.string().describe('The concrete question to ask the user'),
  header: z.string().optional().describe('Optional short heading'),
  options: z
    .array(askOptionSchema)
    .optional()
    .describe('Candidate options; without options the answer is free-form text'),
  multi_select: z
    .boolean()
    .optional()
    .describe('Whether multiple options may be selected (default false)')
})

/** 构建提问工具（仅注入主代理） */
export function buildAskUserTool(fallbackTopicId = 0): StructuredToolInterface {
  return tool(
    async ({ questions }, config) => {
      const configurable = (config?.configurable ?? {}) as Record<string, unknown>
      const topicId =
        typeof configurable.topicId === 'number' && configurable.topicId > 0
          ? configurable.topicId
          : fallbackTopicId
      try {
        const answer = await questionService.ask(topicId, questions, config?.signal)
        return JSON.stringify(answer)
      } catch (err) {
        const tr = getFsToolTexts()
        if ((err as Error)?.name === 'AskAbortedError') {
          return tr.ask.abortedDetail
        }
        return mainFormat(tr.ask.failed, { message: (err as Error).message })
      }
    },
    {
      name: 'ask_user_question',
      description:
        'Ask the user one or more questions and wait for the answers within the same turn (the conversation does not end). Use it when you cannot continue without user input: choosing between approaches, confirming a permission or a destructive action, or filling in missing critical information. Ask several questions at once when they belong together. Put the recommended option first and append "(Recommended)" to its label. The answers arrive as JSON: { answers: [{ id, selected: string[], custom? }] } (a single-choice answer has exactly one element in selected).',
      schema: z.object({
        questions: z
          .array(askQuestionSchema)
          .describe('Questions to ask, in the order they should be shown')
      })
    }
  )
}
