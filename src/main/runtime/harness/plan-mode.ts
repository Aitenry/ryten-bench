import { tool, type StructuredToolInterface } from '../../ai/tools'
import { z } from 'zod'
import logger from 'electron-log'
import {
  getTopicPlanMode,
  setTopicPlanMode
} from '../../database/mapper/harness/harness'
import { mainFormat } from '../../i18n'
import { getAgentToolTexts } from '../../i18n/tool-results-agent'
import {
  PLAN_REVIEW_APPROVE,
  PLAN_REVIEW_KEEP_PLANNING,
  PLAN_REVIEW_KIND
} from '../../../shared/harness/types'
import { questionService } from './ask'

/**
 * 计划模式（plan mode）— 对应 deepseek-harness 的 dsh-plan-mode 体系
 *
 * 机制（参考 DSH，适配 RytenBench 按 topicId 组织的对话）：
 * - 按话题持久化一个布尔开关（harness_topic.plan_mode），重启 / 切话题后仍然有效；
 * - 激活时系统提示词追加一段规划指引：先探索与设计，把完整计划通过 `exit_plan_mode`
 *   交用户审阅，批准之前不直接动手；
 * - `exit_plan_mode` 走既有的提问通道（questionService → 前端 PlanReviewModal）：
 *   用户选「批准」→ 关闭计划模式、模型继续执行；选「继续规划」→ 保持激活，
 *   反馈（可选自由文本）原样回到模型，模型修订后再次调用；
 * - 计划模式只约束提示词与工具清单，**不改变权限档位**：沙箱与审批照常工作
 *  （与 DSH 的「软性层」定位一致；想强制限制请用权限档位）。
 *
 * 状态同步：Runtime 的提示词与工具清单在请求期同步拼装，因此主进程用内存缓存
 * （`PlanModeStore`）读状态；每轮开始前 `ensure(topicId)` 从库里回填，避免进程启动后
 * 第一轮漏掉持久化的计划模式。
 */

/** 计划评审的问题 id（工具层按它取答案） */
export const PLAN_REVIEW_ID = 'plan-review'
/** 计划评审的问题种类：前端据此用专用弹窗（而不是通用提问弹窗）渲染 */
export { PLAN_REVIEW_KIND, PLAN_REVIEW_APPROVE, PLAN_REVIEW_KEEP_PLANNING }

/**
 * 计划模式激活时追加的系统提示词段落。
 *
 * 与 DSH 的 `plan:policy` 同一定位：部署方提供的引导文本，只通过文字约束行为。
 * 用英文与 Rita 基础人设、沙箱说明段保持一致（模型侧提示词统一英文）。
 */
const PLAN_MODE_GUIDANCE = `## Plan mode
You are in plan mode. The user wants to review and approve a plan before any work is carried out.

- Explore first: read the relevant files, trace the code, and check constraints before proposing anything. Do not modify files, run mutating commands, or start long-running work while planning.
- When the design is complete, call exit_plan_mode with the full plan as Markdown, beginning with a heading. The plan must be concrete enough to execute: ordered steps, files to touch, key decisions and their rationale, and any risks or open questions.
- The user reviews the plan. If they approve, plan mode ends and you carry out the plan from your next step. If they ask for changes, their feedback comes back in the tool result: revise the plan and call exit_plan_mode again.
- Do not call exit_plan_mode for partial plans or for simple questions that need no design work.`

export type PlanModeListener = (topicId: number, active: boolean) => void

/**
 * 计划模式存储（进程级单例，按 topicId 隔离）。
 *
 * 内存缓存是为了让 Runtime 的同步拼装（提示词 / 工具清单）能读到状态；数据库是唯一真源。
 */
export class PlanModeStore {
  private readonly cache = new Map<number, boolean>()

  /** 变更回调（主进程注入，广播 harness-plan-updated 给界面上的计划模式徽标） */
  onChange?: PlanModeListener

  /** 从数据库回填某话题的计划模式（已有缓存直接返回；读失败按未激活处理） */
  async ensure(topicId: number): Promise<boolean> {
    if (topicId <= 0) return false
    const cached = this.cache.get(topicId)
    if (cached !== undefined) return cached
    try {
      const active = await getTopicPlanMode(topicId)
      this.cache.set(topicId, active)
      return active
    } catch (err) {
      logger.warn(`[PlanMode] Failed to read plan mode for topic ${topicId}:`, err)
      return false
    }
  }

  /** 同步读取（只对已 ensure 过的话题可靠；未加载按未激活处理） */
  isActive(topicId: number): boolean {
    return this.cache.get(topicId) === true
  }

  /** 切换并持久化；成功后广播，返回最终状态 */
  async setActive(topicId: number, active: boolean): Promise<boolean> {
    if (topicId <= 0) return false
    await setTopicPlanMode(topicId, active)
    this.cache.set(topicId, active)
    logger.info(`[PlanMode] Plan mode ${active ? 'enabled' : 'disabled'} for topic ${topicId}`)
    try {
      this.onChange?.(topicId, active)
    } catch (err) {
      // 广播失败（窗口销毁等）不影响状态本身
      logger.warn('[PlanMode] Failed to broadcast plan mode change:', err)
    }
    return active
  }

  /** 话题删除时丢弃缓存（行已随话题级联删除） */
  forget(topicId: number): void {
    this.cache.delete(topicId)
  }

  /** 丢弃全部内存态（账号数据空间切换时用，与 GoalStore.reset 同一口径） */
  reset(): void {
    this.cache.clear()
  }
}

/** 进程级单例 */
export const planModeStore = new PlanModeStore()

/** 计划模式提示词段落（未激活时为空串，不增加任何 token） */
export function planModePromptSection(active: boolean): string {
  return active ? `\n\n${PLAN_MODE_GUIDANCE}` : ''
}

/**
 * 构建 `exit_plan_mode` 工具（仅在计划模式激活时注入主代理）。
 *
 * 用户审阅走既有提问通道：问题正文就是整份计划（Markdown），前端用专用弹窗渲染；
 * 答案用稳定标记（approve / keep-planning）而不是按钮文案，切换界面语言不会影响判定。
 */
export function buildExitPlanModeTool(topicId: number): StructuredToolInterface {
  return tool(
    async ({ plan }, config) => {
      const tr = getAgentToolTexts()
      if (!planModeStore.isActive(topicId)) {
        return tr.plan.notActive
      }
      const trimmed = plan.trim()
      if (!trimmed) return tr.plan.emptyPlan

      let answer: Awaited<ReturnType<typeof questionService.ask>>
      try {
        answer = await questionService.ask(
          topicId,
          [
            {
              id: PLAN_REVIEW_ID,
              kind: PLAN_REVIEW_KIND,
              header: tr.plan.reviewHeader,
              question: trimmed,
              options: [
                { label: PLAN_REVIEW_APPROVE },
                { label: PLAN_REVIEW_KEEP_PLANNING }
              ]
            }
          ],
          config?.signal
        )
      } catch (err) {
        if ((err as Error)?.name === 'AskAbortedError') return tr.plan.aborted
        return mainFormat(tr.plan.reviewFailed, { message: (err as Error).message })
      }

      const item = answer.answers[0]
      const selected = item?.selected ?? []
      const feedback = item?.custom?.trim()
      if (selected.includes(PLAN_REVIEW_KEEP_PLANNING)) {
        // 保持激活：模型收到反馈后在同一个回合里修订计划并再次提交
        return mainFormat(tr.plan.keepPlanning, { feedback: feedback ? ` — ${feedback}` : '' })
      }
      if (selected.includes(PLAN_REVIEW_APPROVE)) {
        // 批准即离开计划模式：下一次模型请求不再注入规划指引 / 退出工具
        await planModeStore.setActive(topicId, false)
        return feedback
          ? mainFormat(tr.plan.approvedWithFeedback, { feedback })
          : tr.plan.approved
      }
      // 没有可识别的答案（界面被关掉 / 空答案）：按「继续规划」处理，避免误批准
      return tr.plan.reviewNoAnswer
    },
    {
      name: 'exit_plan_mode',
      description:
        'Use only in plan mode. Present the completed plan (full Markdown, starting with a heading) for the user to review. The user may approve — plan mode then ends and you carry out the plan from your next step — or ask for changes; their feedback comes back in the tool result, so revise the plan and present it again. Do not use this tool for partial plans.',
      schema: z.object({
        plan: z
          .string()
          .describe(
            'The complete plan in Markdown, beginning with a heading: ordered steps, files to touch, key decisions and their rationale, risks and open questions.'
          )
      })
    }
  )
}
