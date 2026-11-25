/**
 * 「替换/删除草稿目录前先放掉文件监听」的桥。
 *
 * 工坊服务（service/store/scaffold）刻意不 import electron，离线工装与单元测试
 * 才能用临时目录跑完整的生成→构建→发布链路。但 Windows 上 `fs.watch` 的目录句柄
 * 不允许删除/改名被监听的目录：插件工作区打开着时，删除草稿会 EPERM。
 *
 * 主进程装配时（system/harness.ts）注入工作区监听的真实实现；未注入时（离线工装）
 * 返回 null，调用方照常执行。这样两边都不需要知道对方。
 */

type DirReleaseHook = (dir: string) => (() => void) | null
type DirResumeHook = () => void

let hook: DirReleaseHook | null = null
let resumeHook: DirResumeHook | null = null

/** 注入实现（主进程启动时调用；传 null 取消） */
export function configureWorkshopDirReleaseHook(
  next: DirReleaseHook | null,
  resume: DirResumeHook | null = null
): void {
  hook = next
  resumeHook = resume
}

/**
 * 目录即将被删除/替换：如果它正被工作区监听占用，先放掉监听。
 *
 * @returns 恢复监听的函数（不需要恢复时返回 null）
 */
export function releaseWorkshopDir(dir: string): (() => void) | null {
  try {
    return hook?.(dir) ?? null
  } catch {
    return null
  }
}

/**
 * 操作完成后重新对齐工作区监听（按当前设置）。
 *
 * 用于「旧目录被删掉后又在原位置建了同名目录」的覆盖/重建：`releaseWorkshopDir`
 * 的恢复回调执行时目录还不存在，监听会自然停掉；重建完成后需要再同步一次。
 */
export function resumeWorkshopDirs(): void {
  try {
    resumeHook?.()
  } catch {
    // 监听恢复失败不影响已经完成的文件操作
  }
}
