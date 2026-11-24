/**
 * 运行环境数据目录（`src/main/environment/resolve.ts`）的回归测试。
 *
 * 跑法：`pnpm test:env`（即 `node --no-warnings tests/environment.test.mts`；
 * Node 22+ 自带 TS 类型擦除，不需要先构建）
 *
 * 覆盖：打包态 / 开发态的目录与应用名、两套环境不重叠、`--user-data-dir` 覆盖判定。
 * 这层规则一旦退化（两边又指向同一个 userData），设置 / 数据库 / 插件 / 账号 / 日志
 * 会重新互相污染，所以把它钉成单测，而不是只写在注释里。
 */
import assert from 'node:assert/strict'
import { basename, dirname, join } from 'node:path'
import {
  DEVELOPMENT_APP_NAME,
  DEVELOPMENT_DATA_DIR,
  PRODUCTION_APP_NAME,
  PRODUCTION_DATA_DIR,
  hasUserDataDirOverride,
  resolveEnvironment
} from '../src/main/environment/resolve.ts'

let checks = 0

function check(name: string, fn: () => void): void {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

/** 假的「每用户应用数据根」：Windows 下是 %APPDATA%，测试不关心真实平台形态 */
const appDataDir = join('/fake', 'appdata')

const production = resolveEnvironment({ packaged: true, appDataDir })
const development = resolveEnvironment({ packaged: false, appDataDir })

check('打包态：production / RytenBench / ryten-bench（历史目录保持不变）', () => {
  assert.equal(production.name, 'production')
  assert.equal(production.appName, PRODUCTION_APP_NAME)
  assert.equal(production.dataDirName, PRODUCTION_DATA_DIR)
  assert.equal(production.dataDirName, 'ryten-bench')
  assert.equal(production.userDataDir, join(appDataDir, 'ryten-bench'))
  assert.equal(basename(production.userDataDir), 'ryten-bench')
})

check('开发态：development / RytenBench Dev / ryten-bench-dev', () => {
  assert.equal(development.name, 'development')
  assert.equal(development.appName, DEVELOPMENT_APP_NAME)
  assert.equal(development.dataDirName, DEVELOPMENT_DATA_DIR)
  assert.equal(development.dataDirName, 'ryten-bench-dev')
  assert.equal(development.userDataDir, join(appDataDir, 'ryten-bench-dev'))
  assert.equal(basename(development.userDataDir), 'ryten-bench-dev')
})

check('两套环境是同一 appData 下的两个兄弟目录（互不改写对方）', () => {
  assert.notEqual(production.userDataDir, development.userDataDir)
  assert.equal(dirname(production.userDataDir), appDataDir)
  assert.equal(dirname(development.userDataDir), appDataDir)
})

check('判定只看 isPackaged（`electron .` 与 dev 走开发态，打包产物走发布态）', () => {
  // 同一个 appData 根，只有 packaged 这个开关能改变落点
  assert.deepEqual(resolveEnvironment({ packaged: true, appDataDir }), production)
  assert.deepEqual(resolveEnvironment({ packaged: false, appDataDir }), development)
  // 幂等：多次调用结果一致，不会因为「已经初始化过」换目录
  assert.deepEqual(resolveEnvironment({ packaged: false, appDataDir }), development)
})

check('--user-data-dir 覆盖：= 形式、空格形式、commandLine 解析都认', () => {
  assert.equal(hasUserDataDirOverride(['electron', '.', '--user-data-dir=C:\\tmp\\rb']), true)
  assert.equal(hasUserDataDirOverride(['--user-data-dir', 'C:\\tmp\\rb']), true)
  assert.equal(
    hasUserDataDirOverride([], { hasSwitch: (name: string) => name === 'user-data-dir' }),
    true
  )
})

check('普通启动或相似开关不误判为覆盖', () => {
  assert.equal(hasUserDataDirOverride([]), false)
  assert.equal(hasUserDataDirOverride(['--enable-logging', '--inspect=9229']), false)
  // 只是长得像：不是 --user-data-dir 开关本身
  assert.equal(hasUserDataDirOverride(['--user-data-directory=/tmp/rb']), false)
  assert.equal(hasUserDataDirOverride([], { hasSwitch: () => false }), false)
  assert.equal(hasUserDataDirOverride([], {}), false)
})

console.log(`\nenvironment: ${checks} checks passed`)
