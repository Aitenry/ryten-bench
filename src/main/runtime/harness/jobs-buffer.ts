/**
 * 后台任务输出缓冲的**纯逻辑**（零 import，可被 node 直接加载做离线回归）。
 *
 * 为什么单独一个文件：运行中任务的输出帧必须有上限（长跑 dev server 每秒大量输出帧，
 * 否则主进程内存无界增长），而裁剪最旧帧时必须同步回退 `job_output` 的消费游标——
 * 这两条一起很容易在后续改动里漂移，必须能离线断言。jobs.ts 只负责把它接到注册表上。
 */

/** 输出缓冲状态（jobs.ts 的 JobRecord 结构上满足它） */
export interface FramedOutputState {
  /** 输出帧（每帧是一段文本；按 frameSeparator 连接） */
  outputFrames: string[]
  /** job_output 已读取到的帧位置 */
  cursor: number
  /** 已缓存的字符总数（O(1) 判断是否需要裁剪） */
  bufferedChars: number
}

/** 缓冲上限 */
export interface FrameCapLimits {
  maxChars: number
  maxFrames: number
}

/**
 * 追加一帧并裁剪到上限：超出时从头部丢弃最旧帧，同时把游标回退同样的帧数
 * （保证「已读」与「未读」的相对位置不因裁剪而错位）。
 *
 * @returns 实际丢弃的帧数（0 表示未裁剪）
 */
export function appendFrameWithinCap(
  state: FramedOutputState,
  text: string,
  limits: FrameCapLimits
): number {
  state.outputFrames.push(text)
  state.bufferedChars += text.length
  let dropped = 0
  while (
    state.outputFrames.length > 0 &&
    (state.outputFrames.length > limits.maxFrames || state.bufferedChars > limits.maxChars)
  ) {
    const removed = state.outputFrames.shift() as string
    state.bufferedChars -= removed.length
    state.cursor = Math.max(0, state.cursor - 1)
    dropped += 1
  }
  return dropped
}
