/**
 * 流事件的「回合守卫」。
 *
 * 背景：流事件（chunk / done / error）只带话题 id 时，同一话题上的两轮流事件会被同一个
 * 监听器照单全收——上一轮的迟到事件、或极端情况下并发的另一轮，都会写进当前气泡，
 * 表现就是「输出错乱」「还在跑却突然收尾」。
 *
 * 用法：一次流监听建一个守卫，把它拿到的每个事件的回合 id 传进去；
 * 返回 false 的事件直接丢弃。
 *  - 建的时候就知道回合 id（主进程发起的轮次，标记 chunk 里带着它）：只收这一轮；
 *  - 建的时候不知道（本地发送，id 由主进程分配）：锁在**第一条到达的事件**上；
 *  - 事件没带回合 id（老版本主进程）：一律放行，退回按话题处理。
 */

export type TurnGuard = (eventTurnId?: number | null) => boolean

export function createTurnGuard(expectedTurnId?: number | null): TurnGuard {
  let locked: number | null = expectedTurnId ?? null
  return (eventTurnId?: number | null): boolean => {
    if (eventTurnId == null) return true
    if (locked == null) {
      locked = eventTurnId
      return true
    }
    return locked === eventTurnId
  }
}
