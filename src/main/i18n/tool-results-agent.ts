import { getMainLanguage } from './index'

/**
 * Result texts for goals / background jobs (jobs) / subagents (task, send_message,
 * interrupt_agent, list_agents) / workflows (workflow) / tool guards.
 *
 * **These render on the chat tool call cards, the goal bar and the job bar** (the model reads the
 * same text), so they must follow the UI language.
 *
 * Split of responsibilities with `tool-results.ts` (mnemon tool group), `tool-results-fs.ts`
 * (files/overflow/questions), `tool-results-docs.ts` (knowledge bases/documents) and
 * `tool-results-todos.ts` (to-dos): this file covers runtime tools, subagents and the goal driver.
 *
 * Chinese is the source language; `enUSAgentToolTexts` is constrained by
 * `typeof zhCNAgentToolTexts`, so missing or extra keys are compile-time errors. Interpolation
 * always uses `{{name}}` + `mainFormat`.
 *
 * Note: the **prefix identifiers** of error strings (`META_INVALID:` / `AGENT_CAP:` /
 * `UNSUPPORTED_OPTION:` / `UNSUPPORTED_SCHEMA:` / `WORKFLOW_TIMEOUT:` / `SCRIPT_PARSE:` /
 * `CANCELLED`) and the task status line `[status: ...]` are protocol markers the code checks;
 * they stay in code and are concatenated as-is, not put into the message entries.
 * `GOAL_STALE_REVISION` sits mid-sentence and is passed in as `{{marker}}` by the caller; both
 * languages output it verbatim.
 */
export const zhCNAgentToolTexts = {
  /** Tool executor (agent.ts): the result written to the tool card when a tool throws */
  agent: {
    toolFailed: '工具执行失败: {{message}}',
    toolTimeout:
      '工具 "{{name}}" 执行超时（{{ms}} 毫秒），宿主已停止等待本次结果。请缩小范围重试，或直接根据已有信息继续。'
  },

  /** Skill tool (skills.ts): loads a skill's full text on demand */
  skill: {
    notFound: '没有名为 "{{name}}" 的技能。可用技能：{{names}}',
    header: '## 技能: {{name}}（{{id}}）'
  },

  /** Goal store and goal tools (goal.ts): tool results, thrown errors and authority rejections */
  goal: {
    /** create_goal only accepts a direct human request */
    createRequiresHumanRequest:
      'create_goal 需要人类直接请求（当前为自动续跑轮，无权创建新目标）。',
    createFailed: '创建目标失败: {{message}}',
    readFailed: '读取目标失败: {{message}}',
    updateFailed: '更新目标失败: {{message}}',
    /** Shared by the tool layer and GoalStore.assertCurrent */
    noGoal: '当前话题没有目标。请先用 create_goal 创建。',
    /** Optimistic-concurrency CAS failure (the caller passes 'GOAL_STALE_REVISION' as {{marker}}, output verbatim) */
    staleRevision:
      '目标已变更（{{marker}}）：当前 revision={{current}}，你携带的是 {{provided}}。请先 get_goal 获取最新状态。',
    /** create: single-goal semantics; rejected while an unfinished goal exists */
    alreadyInProgress:
      '当前已有进行中的目标（phase={{phase}}）。请先完成/阻塞该目标，或对现有目标使用 update_goal。',
    cannotPause: '当前 phase={{phase}}，不能暂停。',
    cannotResumeComplete: '已完成的目标不能恢复。',
    cannotResumeRoundLimit: '已达轮次上限（{{limit}}），不能恢复。',
    alreadyComplete: '目标已完成。',
    cannotBlock: '当前 phase={{phase}}，不能标记阻塞。',
    /** Fallback reason when the model gives no blocked_reason */
    defaultBlockedReason: '（未提供原因）',
    unknownAction: '未知 action: {{action}}',
    /** authority: edit/pause/resume require a direct human request */
    requiresHumanRequest:
      '{{action}} 需要人类直接请求（自动续跑轮无权执行该操作；如确需调整，请在用户消息中说明）。',
    /** authority: complete/blocked comes neither from a human nor from exactly the current goal round */
    notAuthorized:
      '{{action}} 无权执行：既非人类直接请求，也非当前目标轮（goal/revision/round 不匹配）。',
    /** authority: minimum round count before blocking in an autonomous round */
    blockedMinRounds:
      '自动标记 blocked 至少需要已进行 {{minRounds}} 轮（当前 {{rounds}} 轮）。若确已无法推进，请在最终回答中向用户说明，由用户决定暂停或调整目标。',
    /** Wrap-up guidance injected after an autonomous round marks the goal complete (wrapup) */
    wrapupComplete: '目标已标记完成。请在最终回答中给出简短收尾：完成成果、关键证据与后续建议。',
    /** Wrap-up guidance injected after an autonomous round marks the goal blocked (wrapup) */
    wrapupBlocked: '目标已标记阻塞（{{code}}）。请在最终回答中向用户说明阻塞原因与可行的下一步。'
  },

  /** Goal round driver (goal-driver.ts): writes blockedReason.message, shown on the goal bar */
  goalDriver: {
    roundLimitReached: '已达轮次上限（{{rounds}} 轮），自动停止'
  },

  /** Plan mode (plan-mode.ts): exit_plan_mode results and the review entry point */
  plan: {
    /** The tool is called outside plan mode (should not happen in the normal flow; guards against the model guessing the call) */
    notActive: '当前未处于计划模式，exit_plan_mode 不可用。',
    emptyPlan: '计划内容为空：请把完整计划（Markdown，以标题开头）放进 plan 参数。',
    /** Small title of the plan review dialog */
    reviewHeader: '计划评审',
    approved: '用户已批准计划。计划模式已关闭，现在开始按该计划执行。',
    approvedWithFeedback:
      '用户已批准计划（附注：{{feedback}}）。计划模式已关闭，现在开始按该计划执行。',
    keepPlanning: '用户要求继续规划{{feedback}}。请根据反馈修订计划，然后再次调用 exit_plan_mode。',
    aborted: '计划评审已中止（本轮被取消），计划模式保持不变。',
    reviewFailed: '计划评审失败：{{message}}。请把计划作为普通回答写给用户。',
    reviewNoAnswer:
      '没有收到有效的评审结果，计划模式保持不变。请再次调用 exit_plan_mode，或请用户直接在输入框反馈。'
  },

  /** Background jobs (jobs.ts): job_output result text and terminal-state descriptions */
  jobs: {
    notFoundInTopic: '任务 {{id}} 不存在或不属于当前话题。',
    notFound: '任务 {{id}} 不存在。',
    /** Replacement text when a terminal job has no output ({{status}} is running/stopping/completed/killed/failed) */
    terminalNoOutput: '（任务已{{status}}）',
    noNewOutput: '（任务 {{id}} 暂无新输出）',
    /** Default reason written to the snapshot detail when job_kill gives no reason */
    userKillReason: '（用户请求终止）',
    /** Cancellation reason passed to the runner when the topic is deleted */
    topicDeletedReason: '话题已删除'
  },

  /** The task tool and subagent execution (subagent.ts) */
  subagent: {
    notFound: '子智能体 "{{type}}" 不存在。可用子智能体：{{names}}',
    /** List placeholder when no subagent is configured */
    noneAvailable: '（无）',
    /** Start receipt for background=true (includes job_output/send_message/interrupt_agent/list_agents usage) */
    backgroundStarted:
      '已启动后台子智能体会话（subagent_id={{id}}）：{{label}}。会话在后台继续执行，用 job_output(job_id="{{id}}", wait=true) 读取当前轮输出；send_message(subagent_id="{{id}}", message=...) 让它继续下一轮工作；interrupt_agent(agent_id="{{id}}") 中断当前轮；list_agents 查看全部会话状态。',
    failed: '子智能体执行失败: {{message}}',
    /** Tool call rounds exhausted but some output was produced */
    roundLimitNote: '\n（子智能体已达到工具调用轮次上限，自动停止）',
    /** Tool call rounds exhausted with no output at all */
    roundLimitIncomplete: '（子智能体已达到工具调用轮次上限，未能完成任务）',
    /** Subagent finished without producing text (shared by subagent.ts and subagent-sessions.ts) */
    noTextOutput: '（子智能体无文本输出）'
  },

  /** Session-continuation control tools and subagent session runs (subagent-sessions.ts) */
  /** Subagent authoring tool (agent_create): the main agent delegates building a subagent config */
  agentAuthoring: {
    created:
      '已创建子代理「{{name}}」（id={{id}}）：它会出现在设置 → 智能体的列表中，并已注册为可复用子代理。现在可以直接调用 task(subagent_type="{{name}}", prompt=...) 派发任务。',
    failed: '创建子代理失败：{{message}}'
  },
  subagentSessions: {
    /** Session/task display name: `<subagent name>: <first 40 chars of the task>` */
    sessionLabel: '{{name}}：{{task}}',
    notFound: '子代理会话 {{id}} 不存在或不属于当前话题。',
    deletedWithTopic: '子代理会话 {{id}} 已随话题删除。',
    /** Tool call line appended to the task output */
    toolCallLine: '[工具] {{name}}（参数：{{input}}）',
    /** This turn was interrupted by interrupt_agent / job_kill */
    interrupted: '（本轮已被中断）',
    /** This turn failed ({{message}} is the error text or the round-limit note) */
    runFailed: '（运行失败：{{message}}）',
    /** Failure note when the round limit is hit */
    roundLimitReached: '子智能体达到工具调用轮次上限',
    sendFailed: '发送失败: {{message}}',
    /** An inactive session restored after a restart: explicitly refuses continuation when cold resume fails */
    inactiveCannotResume:
      '子代理会话 {{id}} 是重启后恢复的历史记录，但本次冷恢复失败（模型或配置不可用）；请重新派发一个后台任务。'
  },

  /** Workflow tool (workflow.ts): phrasing in error strings (prefix identifiers are concatenated in code) */
  workflow: {
    metaMustBeObject: 'meta 必须是对象',
    metaNameRequired: 'meta.name 必须是非空字符串',
    metaPhasesRequired: 'meta.phases 必须是 {title} 数组',
    agentCapExceeded: '代理总数超过上限（{{limit}}）',
    unsupportedOption: 'agent 选项 "{{key}}" 不受支持（仅 label/phase/schema/model）',
    emptyPrompt: 'agent() 需要非空的字符串 prompt',
    unsupportedSchema:
      '{{path}}.{{key}}（仅支持 type/properties/required/additionalProperties/items/enum/const/oneOf）',
    /** Wall-clock hard limit triggered (30 minutes, matching WORKFLOW_HARD_TIMEOUT_MS) */
    timeout: '脚本执行超过 30 分钟，已强制停止'
  }
}

export const enUSAgentToolTexts: typeof zhCNAgentToolTexts = {
  agent: {
    toolFailed: 'Tool execution failed: {{message}}',
    toolTimeout:
      'The tool "{{name}}" timed out after {{ms}} ms; the host stopped waiting for this call. Retry with a smaller scope, or continue with the information you already have.'
  },

  /** Skill tool (skills.ts): loads a skill body on demand */
  skill: {
    notFound: 'No skill named "{{name}}". Available skills: {{names}}',
    header: '## Skill: {{name}} ({{id}})'
  },

  goal: {
    createRequiresHumanRequest:
      'create_goal requires a direct human request (this is an automatic continuation round, which may not create a new goal).',
    createFailed: 'Failed to create the goal: {{message}}',
    readFailed: 'Failed to read the goal: {{message}}',
    updateFailed: 'Failed to update the goal: {{message}}',
    noGoal: 'This topic has no goal. Create one with create_goal first.',
    staleRevision:
      'The goal has changed ({{marker}}): the current revision is {{current}} but you passed {{provided}}. Call get_goal to get the latest state first.',
    alreadyInProgress:
      'A goal is already in progress (phase={{phase}}). Complete or block it first, or call update_goal on the existing goal.',
    cannotPause: 'Cannot pause while phase={{phase}}.',
    cannotResumeComplete: 'A completed goal cannot be resumed.',
    cannotResumeRoundLimit:
      'The round limit ({{limit}}) has been reached; the goal cannot be resumed.',
    alreadyComplete: 'The goal is already complete.',
    cannotBlock: 'Cannot mark the goal blocked while phase={{phase}}.',
    defaultBlockedReason: '(no reason provided)',
    unknownAction: 'Unknown action: {{action}}',
    requiresHumanRequest:
      '{{action}} requires a direct human request (an automatic continuation round may not perform this action; if it is really needed, explain it in the user message).',
    notAuthorized:
      'Not authorized to perform {{action}}: this is neither a direct human request nor the current goal round (goal/revision/round do not match).',
    blockedMinRounds:
      'Marking the goal blocked automatically requires at least {{minRounds}} rounds already started (currently {{rounds}}). If you truly cannot make progress, explain it to the user in your final answer and let the user decide whether to pause or adjust the goal.',
    wrapupComplete:
      'The goal is marked complete. In your final answer, give a brief wrap-up: what was achieved, the key evidence, and suggested next steps.',
    wrapupBlocked:
      'The goal is marked blocked ({{code}}). In your final answer, explain the blocking condition and the viable next steps to the user.'
  },

  goalDriver: {
    roundLimitReached: 'Round limit reached ({{rounds}} rounds); stopping automatically'
  },

  plan: {
    notActive: 'Plan mode is not active; exit_plan_mode is unavailable.',
    emptyPlan:
      'The plan is empty: pass the complete plan in Markdown (starting with a heading) in the plan argument.',
    reviewHeader: 'Plan review',
    approved:
      'The user approved the plan. Plan mode is now off; carry out the plan from this step.',
    approvedWithFeedback:
      'The user approved the plan (note: {{feedback}}). Plan mode is now off; carry out the plan from this step.',
    keepPlanning:
      'The user asked to keep planning{{feedback}}. Revise the plan accordingly and call exit_plan_mode again.',
    aborted: 'The plan review was aborted (this turn was cancelled); plan mode is unchanged.',
    reviewFailed:
      'The plan review failed: {{message}}. Present the plan to the user as a normal answer instead.',
    reviewNoAnswer:
      'No valid review result was received; plan mode is unchanged. Call exit_plan_mode again, or ask the user for direct feedback.'
  },

  jobs: {
    notFoundInTopic: 'Job {{id}} does not exist or does not belong to this topic.',
    notFound: 'Job {{id}} does not exist.',
    terminalNoOutput: '(job already {{status}})',
    noNewOutput: '(no new output from job {{id}} yet)',
    userKillReason: '(termination requested by the user)',
    topicDeletedReason: 'Topic deleted'
  },

  subagent: {
    notFound: 'Subagent "{{type}}" does not exist. Available subagents: {{names}}',
    noneAvailable: '(none)',
    backgroundStarted:
      'Background subagent session started (subagent_id={{id}}): {{label}}. The session keeps running in the background; use job_output(job_id="{{id}}", wait=true) to read the current turn output, send_message(subagent_id="{{id}}", message=...) to give it its next turn, interrupt_agent(agent_id="{{id}}") to interrupt the current turn, and list_agents to inspect every session status.',
    failed: 'Subagent execution failed: {{message}}',
    roundLimitNote: '\n(The subagent reached its tool call round limit and stopped automatically)',
    roundLimitIncomplete:
      '(The subagent reached its tool call round limit and did not finish the task)',
    noTextOutput: '(the subagent produced no text output)'
  },

  agentAuthoring: {
    created:
      'Subagent "{{name}}" created (id={{id}}). It is persisted in Settings → Agents and can now be reused. Delegate with task(subagent_type="{{name}}", prompt=...).',
    failed: 'Failed to create subagent: {{message}}'
  },
  subagentSessions: {
    sessionLabel: '{{name}}: {{task}}',
    notFound: 'Subagent session {{id}} does not exist or does not belong to this topic.',
    deletedWithTopic: 'Subagent session {{id}} was deleted together with the topic.',
    toolCallLine: '[Tool] {{name}} (args: {{input}})',
    interrupted: '(this turn was interrupted)',
    runFailed: '(run failed: {{message}})',
    roundLimitReached: 'the subagent reached its tool call round limit',
    sendFailed: 'Send failed: {{message}}',
    inactiveCannotResume:
      'Subagent session {{id}} is a restored history record, but cold resume failed (model or configuration unavailable). Start a new background task instead.'
  },

  workflow: {
    metaMustBeObject: 'meta must be an object',
    metaNameRequired: 'meta.name must be a non-empty string',
    metaPhasesRequired: 'meta.phases must be an array of {title} objects',
    agentCapExceeded: 'the total agent cap ({{limit}}) has been exceeded',
    unsupportedOption: 'agent option "{{key}}" is not supported (only label/phase/schema/model)',
    emptyPrompt: 'agent() requires a non-empty string prompt',
    unsupportedSchema:
      '{{path}}.{{key}} (only type/properties/required/additionalProperties/items/enum/const/oneOf are supported)',
    timeout: 'the script ran for more than 30 minutes and was force-stopped'
  }
}

export function getAgentToolTexts(): typeof zhCNAgentToolTexts {
  return getMainLanguage() === 'en-US' ? enUSAgentToolTexts : zhCNAgentToolTexts
}
