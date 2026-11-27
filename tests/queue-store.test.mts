/**
 * 插话队列状态机（services/harness/queue-store.ts）的回归测试。
 *
 * 跑法：`node --no-warnings tests/queue-store.test.mts`
 *
 * 覆盖：回合登记（begin/end/current/isActive）、入队与视图、插话（steer → 注入 → 回退）
 * 的三条通道、删除 / 改写、清空、以及「结束旧回合不会清掉新回合」的守卫。
 */
import assert from 'node:assert/strict'
import { harnessQueue, type QueuedMessageView } from '../src/main/services/harness/queue-store.ts'

const TOPIC = 7

// ── 1. 回合登记：同话题一个新的 begin 覆盖旧的，旧回合收尾不能清掉新回合 ──────────
assert.equal(harnessQueue.isTurnActive(TOPIC), false)
const first = harnessQueue.beginTurn(TOPIC)
assert.ok(first > 0)
assert.equal(harnessQueue.isTurnActive(TOPIC), true)
assert.equal(harnessQueue.currentTurnId(TOPIC), first)

const second = harnessQueue.beginTurn(TOPIC)
assert.notEqual(second, first)
harnessQueue.endTurn(TOPIC, first) // 旧回合收尾：不能清掉 second
assert.equal(harnessQueue.currentTurnId(TOPIC), second, '旧回合收尾不应清掉新回合')
harnessQueue.endTurn(TOPIC, second)
assert.equal(harnessQueue.isTurnActive(TOPIC), false)
assert.equal(harnessQueue.currentTurnId(TOPIC), null)

// ── 2. 入队 / 视图 / 取出：FIFO ────────────────────────────────────────────────
assert.equal(harnessQueue.hasPending(TOPIC), false)
const a = harnessQueue.enqueue({
  topicId: TOPIC,
  senderId: 1,
  text: '第一条',
  attachments: { images: ['data:image/png;base64,AAA'], documents: [{ fileName: 'a.pdf', filePath: 'x/a.pdf' }] }
})
const b = harnessQueue.enqueue({ topicId: TOPIC, senderId: 1, text: '第二条' })
assert.equal(harnessQueue.hasPending(TOPIC), true)

const view = harnessQueue.view(TOPIC)
assert.equal(view.length, 2)
assert.equal(view[0].id, a.id)
assert.equal(view[0].text, '第一条')
// 视图里附件只给名字（不驮 dataURL）
assert.deepEqual(view[0].attachments, [
  { fileName: 'a.pdf', isImage: false },
  { fileName: 'image-1', isImage: true }
])
assert.deepEqual(harnessQueue.view(TOPIC)[1].attachments, [])

// 取出队首（回合结束后自动接续用）
const shifted = harnessQueue.shift(TOPIC)
assert.equal(shifted?.id, a.id)
assert.equal(harnessQueue.view(TOPIC).length, 1)
assert.equal(harnessQueue.view(TOPIC)[0].id, b.id)
// 取空后再取是 null（循环终止条件之一）
harnessQueue.shift(TOPIC)
assert.equal(harnessQueue.shift(TOPIC), null)
assert.equal(harnessQueue.hasPending(TOPIC), false)

// ── 3. 改写 / 删除 ────────────────────────────────────────────────────────────
const c = harnessQueue.enqueue({ topicId: TOPIC, senderId: 1, text: '待改写' })
assert.equal(harnessQueue.update(TOPIC, c.id, '改好了'), true)
assert.equal(harnessQueue.view(TOPIC)[0].text, '改好了')
assert.equal(harnessQueue.update(TOPIC, c.id, '   '), false, '空白改写应当被拒绝')
assert.equal(harnessQueue.remove(TOPIC, c.id), true)
assert.equal(harnessQueue.view(TOPIC).length, 0)
assert.equal(harnessQueue.remove(TOPIC, 'no-such-id'), false)

// ── 4. 插话：steer → 注入 → 消费（三条通道的边界）──────────────────────────────
const d = harnessQueue.enqueue({ topicId: TOPIC, senderId: 1, text: '立即插话' })
const steered = harnessQueue.steer(TOPIC, d.id)
assert.equal(steered?.id, d.id)
// 已从排队区摘走，等注入边界
assert.equal(harnessQueue.view(TOPIC).length, 0)
assert.equal(harnessQueue.injectionCount(TOPIC), 1)

const injections = harnessQueue.takeInjections(TOPIC)
assert.equal(injections.length, 1)
assert.equal(injections[0].id, d.id)
// 取空后缓冲清掉；已注入的条目不再回退到队列
assert.equal(harnessQueue.injectionCount(TOPIC), 0)
harnessQueue.releaseHolds(TOPIC)
assert.equal(harnessQueue.view(TOPIC).length, 0, '已注入的插话不应被 releaseHolds 放回队列')

// ── 5. 没等到注入边界：releaseHolds 放回队列并标 held ──────────────────────────
const e = harnessQueue.enqueue({ topicId: TOPIC, senderId: 1, text: '没赶上边界' })
harnessQueue.steer(TOPIC, e.id)
harnessQueue.releaseHolds(TOPIC) // 回合结束，仍有待注入条目
const regained = harnessQueue.view(TOPIC)
assert.equal(regained.length, 1)
assert.equal(regained[0].id, e.id)
assert.equal(regained[0].held, true, '没注入的插话要标 held，提示用户')

// 再插话一次并丢弃（用户点了停止）：不回退、不重复
harnessQueue.steer(TOPIC, e.id)
harnessQueue.dropInjections(TOPIC)
assert.equal(harnessQueue.view(TOPIC).length, 0)
harnessQueue.releaseHolds(TOPIC)
assert.equal(harnessQueue.view(TOPIC).length, 0, '停止后作废的插话不应被放回队列')

// ── 6. 清空 / 重置（切话题、换账号数据空间）────────────────────────────────────
harnessQueue.enqueue({ topicId: TOPIC, senderId: 1, text: '要清掉的' })
harnessQueue.clear(TOPIC)
assert.equal(harnessQueue.view(TOPIC).length, 0)

harnessQueue.beginTurn(TOPIC)
harnessQueue.enqueue({ topicId: 9, senderId: 1, text: '另一个话题' })
harnessQueue.reset()
assert.equal(harnessQueue.isTurnActive(TOPIC), false)
assert.equal(harnessQueue.view(9).length, 0)

// ── 7. 回调广播：enqueue/shift/remove 都会推一次视图 ────────────────────────────
const events: { topicId: number; queue: QueuedMessageView[] }[] = []
harnessQueue.onChanged = (event) => events.push(event)
const f = harnessQueue.enqueue({ topicId: TOPIC, senderId: 1, text: '广播' })
harnessQueue.shift(TOPIC)
assert.equal(events.length, 2)
assert.equal(events[0].topicId, TOPIC)
assert.equal(events[0].queue[0].id, f.id)
assert.equal(events[1].queue.length, 0)
harnessQueue.onChanged = null

console.log('queue-store: all assertions passed')
