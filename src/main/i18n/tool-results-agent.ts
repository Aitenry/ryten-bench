import { getMainLanguage } from './index'

/**
 * 目标（goal）/ 后台任务（jobs）/ 子代理（task、send_message、interrupt_agent、list_agents）/
 * 工作流（workflow）/ 工具护栏的返回文案。
 *
 * **会渲染在聊天的工具调用卡片、目标条与任务条上**（模型读到的也是同一份文本），
 * 因此必须跟随界面语言。
 *
 * 与 `tool-results.ts`（mnemon 工具组）、`tool-results-fs.ts`（文件/溢出/提问）、
 * `tool-results-docs.ts`（知识库/文档）、`tool-results-todos.ts`（待办）的分工：
 * 这边是运行时工具、子代理与目标驱动器。
 *
 * 中文是源语言，`enUSAgentToolTexts` 用 `typeof zhCNAgentToolTexts` 约束，
 * 缺键/多键都是编译期错误。插值统一用 `{{name}}` + `mainFormat`。
 *
 * 注意：错误串的**前缀标识符**（`META_INVALID:` / `AGENT_CAP:` / `UNSUPPORTED_OPTION:` /
 * `UNSUPPORTED_SCHEMA:` / `WORKFLOW_TIMEOUT:` / `SCRIPT_PARSE:` / `CANCELLED`）与任务状态行
 * `[status: ...]` 是程序判断用的协议标记，留在代码里原样拼接，不放进词条；
 * `GOAL_STALE_REVISION` 位于句中，作为 `{{marker}}` 由调用方传入，两种语言都原样输出。
 */
export const zhCNAgentToolTexts = {
  /** 工具执行器（agent.ts）：工具抛错时写进工具卡片的返回 */
  agent: {
    toolFailed: '工具执行失败: {{message}}'
  },

  /** 目标存储与目标工具（goal.ts）：工具返回、抛错与 authority 拒绝 */
  goal: {
    /** create_goal 仅限人类直接请求 */
    createRequiresHumanRequest:
      'create_goal 需要人类直接请求（当前为自动续跑轮，无权创建新目标）。',
    createFailed: '创建目标失败: {{message}}',
    readFailed: '读取目标失败: {{message}}',
    updateFailed: '更新目标失败: {{message}}',
    /** 工具层与 GoalStore.assertCurrent 共用 */
    noGoal: '当前话题没有目标。请先用 create_goal 创建。',
    /** CAS 乐观并发失败（{{marker}} 由调用方传 'GOAL_STALE_REVISION'，原样输出） */
    staleRevision:
      '目标已变更（{{marker}}）：当前 revision={{current}}，你携带的是 {{provided}}。请先 get_goal 获取最新状态。',
    /** create：单目标语义，已有未完成目标时拒绝 */
    alreadyInProgress:
      '当前已有进行中的目标（phase={{phase}}）。请先完成/阻塞该目标，或对现有目标使用 update_goal。',
    cannotPause: '当前 phase={{phase}}，不能暂停。',
    cannotResumeComplete: '已完成的目标不能恢复。',
    cannotResumeRoundLimit: '已达轮次上限（{{limit}}），不能恢复。',
    alreadyComplete: '目标已完成。',
    cannotBlock: '当前 phase={{phase}}，不能标记阻塞。',
    /** 模型未给 blocked_reason 时的兜底原因 */
    defaultBlockedReason: '（未提供原因）',
    unknownAction: '未知 action: {{action}}',
    /** authority：edit/pause/resume 要求人类直接请求 */
    requiresHumanRequest:
      '{{action}} 需要人类直接请求（自动续跑轮无权执行该操作；如确需调整，请在用户消息中说明）。',
    /** authority：complete/blocked 既不来自人类也不精确命中当前目标轮 */
    notAuthorized:
      '{{action}} 无权执行：既非人类直接请求，也非当前目标轮（goal/revision/round 不匹配）。',
    /** authority：自主轮 blocked 的最小轮数门槛 */
    blockedMinRounds:
      '自动标记 blocked 至少需要已进行 {{minRounds}} 轮（当前 {{rounds}} 轮）。若确已无法推进，请在最终回答中向用户说明，由用户决定暂停或调整目标。',
    /** 自主轮 complete 后注入的收尾指引（wrapup） */
    wrapupComplete: '目标已标记完成。请在最终回答中给出简短收尾：完成成果、关键证据与后续建议。',
    /** 自主轮 blocked 后注入的收尾指引（wrapup） */
    wrapupBlocked: '目标已标记阻塞（{{code}}）。请在最终回答中向用户说明阻塞原因与可行的下一步。'
  },

  /** 目标轮次驱动器（goal-driver.ts）：写入 blockedReason.message，显示在目标条上 */
  goalDriver: {
    roundLimitReached: '已达轮次上限（{{rounds}} 轮），自动停止'
  },

  /** 计划模式（plan-mode.ts）：exit_plan_mode 的返回与评审入口 */
  plan: {
    /** 工具不在计划模式下被调用（正常流程不会出现；防模型自行猜测调用） */
    notActive: '当前未处于计划模式，exit_plan_mode 不可用。',
    emptyPlan: '计划内容为空：请把完整计划（Markdown，以标题开头）放进 plan 参数。',
    /** 计划评审弹窗的小标题 */
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

  /** 后台任务（jobs.ts）：job_output 的返回文本与任务终态说明 */
  jobs: {
    notFoundInTopic: '任务 {{id}} 不存在或不属于当前话题。',
    notFound: '任务 {{id}} 不存在。',
    /** 终态任务无输出时的替代文本（{{status}} 为 running/stopping/completed/killed/failed） */
    terminalNoOutput: '（任务已{{status}}）',
    noNewOutput: '（任务 {{id}} 暂无新输出）',
    /** job_kill 未给 reason 时写入快照 detail 的默认原因 */
    userKillReason: '（用户请求终止）',
    /** 话题删除时传给运行者的取消原因 */
    topicDeletedReason: '话题已删除'
  },

  /** task 工具与子代理执行（subagent.ts） */
  subagent: {
    notFound: '子智能体 "{{type}}" 不存在。可用子智能体：{{names}}',
    /** 一个子智能体都没配置时的清单占位 */
    noneAvailable: '（无）',
    /** background=true 的启动回执（含 job_output/send_message/interrupt_agent/list_agents 用法） */
    backgroundStarted:
      '已启动后台子智能体会话（subagent_id={{id}}）：{{label}}。会话在后台继续执行，用 job_output(job_id="{{id}}", wait=true) 读取当前轮输出；send_message(subagent_id="{{id}}", message=...) 让它继续下一轮工作；interrupt_agent(agent_id="{{id}}") 中断当前轮；list_agents 查看全部会话状态。',
    failed: '子智能体执行失败: {{message}}',
    /** 工具调用轮次耗尽但已有部分输出 */
    roundLimitNote: '\n（子智能体已达到工具调用轮次上限，自动停止）',
    /** 工具调用轮次耗尽且没有任何输出 */
    roundLimitIncomplete: '（子智能体已达到工具调用轮次上限，未能完成任务）',
    /** 子代理跑完但没产出文本（subagent.ts 与 subagent-sessions.ts 共用） */
    noTextOutput: '（子智能体无文本输出）'
  },

  /** 续接会话控制工具与子代理会话运行（subagent-sessions.ts） */
  /** 子代理作者化工具（agent_create）：主智能体委派构建子代理配置 */
  agentAuthoring: {
    created:
      '已创建子代理「{{name}}」（id={{id}}）：它会出现在设置 → 智能体的列表中，并已注册为可复用子代理。现在可以直接调用 task(subagent_type="{{name}}", prompt=...) 派发任务。',
    failed: '创建子代理失败：{{message}}'
  },
  subagentSessions: {
    /** 会话/任务显示名：`<子代理名>：<任务首 40 字>` */
    sessionLabel: '{{name}}：{{task}}',
    notFound: '子代理会话 {{id}} 不存在或不属于当前话题。',
    deletedWithTopic: '子代理会话 {{id}} 已随话题删除。',
    /** 追加进任务输出的工具调用行 */
    toolCallLine: '[工具] {{name}}（参数：{{input}}）',
    /** 本轮被 interrupt_agent / job_kill 中断 */
    interrupted: '（本轮已被中断）',
    /** 本轮运行失败（{{message}} 为错误文本或轮次上限说明） */
    runFailed: '（运行失败：{{message}}）',
    /** 轮次上限时的失败说明 */
    roundLimitReached: '子智能体达到工具调用轮次上限',
    sendFailed: '发送失败: {{message}}',
    /** 重启后恢复的 inactive 会话：冷恢复失败时明确拒绝续聊 */
    inactiveCannotResume:
      '子代理会话 {{id}} 是重启后恢复的历史记录，但本次冷恢复失败（模型或配置不可用）；请重新派发一个后台任务。'
  },

  /** 工作流工具（workflow.ts）：错误串里的话术（前缀标识符由代码拼接） */
  workflow: {
    metaMustBeObject: 'meta 必须是对象',
    metaNameRequired: 'meta.name 必须是非空字符串',
    metaPhasesRequired: 'meta.phases 必须是 {title} 数组',
    agentCapExceeded: '代理总数超过上限（{{limit}}）',
    unsupportedOption: 'agent 选项 "{{key}}" 不受支持（仅 label/phase/schema/model）',
    emptyPrompt: 'agent() 需要非空的字符串 prompt',
    unsupportedSchema:
      '{{path}}.{{key}}（仅支持 type/properties/required/additionalProperties/items/enum/const/oneOf）',
    /** 墙钟硬上限触发（30 分钟与 WORKFLOW_HARD_TIMEOUT_MS 对应） */
    timeout: '脚本执行超过 30 分钟，已强制停止'
  }
}

export const enUSAgentToolTexts: typeof zhCNAgentToolTexts = {
  agent: {
    toolFailed: 'Tool execution failed: {{message}}'
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
