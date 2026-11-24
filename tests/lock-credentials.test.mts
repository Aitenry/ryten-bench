/**
 * 锁屏凭据（`src/main/lock/credentials.ts`）的回归测试。
 *
 * 跑法：`pnpm test:lock`（即 `node --no-warnings tests/lock-credentials.test.mts`；
 * Node 22+ 自带 TS 类型擦除，不需要先构建）
 *
 * 这层规则一旦退化，锁屏就回到「6 位数字的裸 MD5、摘要还能被读走」的状态 ——
 * 所以把摘要格式、加盐、旧 MD5 兼容、坏数据关闭这几条钉成单测。
 */
import assert from 'node:assert/strict'
import {
  isLegacyCodeHash,
  isLockCode,
  isScryptCodeHash,
  verifyLockCode,
  hashLockCode
} from '../src/main/lock/credentials.ts'

let checks = 0

function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const result = fn()
  if (result instanceof Promise) {
    return result.then(() => {
      checks += 1
      console.log(`  ok  ${name}`)
    })
  }
  checks += 1
  console.log(`  ok  ${name}`)
}

const MD5_123456 = 'e10adc3949ba59abbe56e057f20f883e'

await check('6 位纯数字才算合法解锁码', () => {
  assert.equal(isLockCode('123456'), true)
  assert.equal(isLockCode('000000'), true)
  for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', null, undefined]) {
    assert.equal(isLockCode(bad), false, `不应接受：${String(bad)}`)
  }
})

await check('新摘要带 scrypt 前缀且包含随机盐', async () => {
  const a = await hashLockCode('123456')
  const b = await hashLockCode('123456')
  assert.equal(isScryptCodeHash(a), true)
  assert.equal(isLegacyCodeHash(a), false)
  assert.match(a, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/)
  // 同一密码两次摘要必须不同（盐不同），否则就是回到了彩虹表可查的裸哈希
  assert.notEqual(a, b)
})

await check('正确密码通过、错误密码不通过', async () => {
  const stored = await hashLockCode('246810')
  const right = await verifyLockCode('246810', stored)
  assert.equal(right.matched, true)
  assert.equal(right.legacy, false)
  const wrong = await verifyLockCode('246811', stored)
  assert.equal(wrong.matched, false)
})

await check('旧版裸 MD5 仍可校验，并标记 legacy 供调用方升级', async () => {
  const result = await verifyLockCode('123456', MD5_123456)
  assert.equal(result.matched, true)
  assert.equal(result.legacy, true)
  const wrong = await verifyLockCode('654321', MD5_123456)
  assert.equal(wrong.matched, false)
})

await check('坏摘要一律按不匹配处理（失败关闭）', async () => {
  for (const stored of [
    '',
    'plaintext',
    'scrypt$16384$8$1$short$short',
    'scrypt$999999999$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'scrypt$16384$8$1$!!not-base64url!!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'e10adc3949ba59abbe56e057f20f883e00'
  ]) {
    const result = await verifyLockCode('123456', stored)
    assert.equal(result.matched, false, `坏摘要不应通过：${stored}`)
  }
})

await check('非法密码不允许生成摘要', async () => {
  await assert.rejects(() => hashLockCode('12345'))
  await assert.rejects(() => hashLockCode('abcdef'))
})

console.log(`\n全部通过（${checks} 项）`)
