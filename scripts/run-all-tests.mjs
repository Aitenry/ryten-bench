/**
 * 全量单元测试运行器：顺序执行 tests/ 下所有 *.test.mts，每个文件一个 Node 进程。
 *
 * 为什么不用测试框架：项目现有测试都是「零依赖脚本 + node:assert」形态，直接按文件
 * 起进程最贴近它们的跑法（`node --no-warnings tests/xxx.test.mts`），失败即非零退出，
 * 也不引入新依赖。某个文件失败不会中断其余文件，最后统一汇总。
 *
 * 跑法：`pnpm test:all`（CI / 发布前的全量单元测试入口）
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TESTS_DIR = join(ROOT, 'tests')

const files = readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith('.test.mts'))
  .sort()

if (files.length === 0) {
  console.error('No tests/*.test.mts found')
  process.exit(1)
}

const results = []
for (const file of files) {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, ['--no-warnings', join(TESTS_DIR, file)], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8'
  })
  const ms = Date.now() - startedAt
  const ok = result.status === 0
  results.push({ file, ok, ms, status: result.status })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  (${ms}ms)`)
  if (!ok) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    if (output) console.log(output.split('\n').slice(-25).join('\n'))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} test files passed`)
if (failed.length > 0) {
  console.error(`Failed: ${failed.map((r) => r.file).join(', ')}`)
  process.exit(1)
}
