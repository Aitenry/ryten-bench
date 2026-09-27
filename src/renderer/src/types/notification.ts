/**
 * 通知中心的**通用**通知类型（core 服务，插件可消费）。
 *
 * 归属边界：通知的「载体」属于外壳（铃铛列表在 `NotificationList`），
 * 而「通知的具体形状」属于产生它的插件（例如图谱构建进度属于 notes）。
 * 因此 core 只声明最小通用契约：能定位、能分类、能点击、能显示标题与描述。
 *
 * 插件侧在自己的模块里扩展它（notes 的 `providers/build-progress.ts` 定义
 * `BuildProgressNotification`），扩展字段以可选形式存在于本类型上，
 * 列表按字段名读取——core 因此不需要 import 任何插件的通知类型。
 */
export interface NotificationItem {
  id: string
  /** 通知类别（当前只有 'build_progress'；未来插件新增类别只需在这里放宽为字符串） */
  type: string
  title: string
  description: string
  timestamp: number
  readonly?: boolean
  read: boolean
  onClick?: () => void

  /** 插件扩展字段（如构建进度的 wikiId / overallProgress / completed），core 按需读取 */
  [key: string]: unknown
}

/** 通知基础字段（插件扩展自己的通知类型时 `extends` 它） */
export type BaseNotification = NotificationItem
