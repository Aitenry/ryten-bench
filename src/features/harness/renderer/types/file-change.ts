/**
 * 文件改动视图类型。
 *
 * 真源在主进程（`src/plugins/harness/main/workspace/file-history.ts`），这里只做一次转发，
 * 避免前端另起一套定义后与主进程漂移；跨进程 DTO 的归口是 `shared/types.ts`。
 */
export type { FileChangeView, FileChangeContent } from '../../shared/types'
