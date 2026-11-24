/**
 * 锁屏相关的常量（主进程与设置校验共用）。
 *
 * 自动锁屏的档位是**有限枚举**而不是任意数字：设置页只给这几档，主进程也只接受这几档，
 * 避免设置文件被手改成 `autoLockMinutes: 0.0001` 之类的值把界面锁死。
 */

/** 首次落盘 / 未设置时的自动锁屏时长（分钟） */
export const DEFAULT_AUTO_LOCK_MINUTES = 5

/** 设置页可选的自动锁屏时长（分钟）；0 = 关闭自动锁屏 */
export const AUTO_LOCK_MINUTES_OPTIONS = [0, 1, 5, 15, 30] as const

export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES_OPTIONS)[number]

/** 出厂默认解锁码（老版本写死 MD5('123456')，新装用户也先用它，方便首次启用） */
export const DEFAULT_LOCK_CODE = '123456'

/** 是否是合法的自动锁屏档位 */
export function isAutoLockMinutes(value: unknown): value is AutoLockMinutes {
  return (
    typeof value === 'number' && (AUTO_LOCK_MINUTES_OPTIONS as readonly number[]).includes(value)
  )
}
