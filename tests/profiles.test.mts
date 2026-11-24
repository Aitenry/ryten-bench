/**
 * 账号级本地数据空间（profiles/manager.ts）的回归测试。
 *
 * 跑法：`node test/profiles.test.ts`（Node 22 自带 TS 类型擦除，无需构建）
 *
 * 覆盖：key 推导、会话读取、首次认领、A↔B 对调、全新账号、未登录空间、
 * 以及「对调过程中崩溃」的两个阶段恢复、异常冲突归档。
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ANONYMOUS_PROFILE,
  PROFILE_ITEMS,
  applyProfile,
  deriveProfileKey,
  profileDir,
  profileJournalPath,
  profileMarkerPath,
  profileSessionPath,
  readProfileMarker,
  readSessionIdentity
} from '../src/main/profiles/manager.ts'

let checks = 0

function check(name: string, fn: () => void): void {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rb-profile-test-'))
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf-8')
}

function seedItems(base: string, tag: string): void {
  writeFile(path.join(base, 'RytenBenchDB', 'PG_VERSION'), `db:${tag}`)
  writeFile(
    path.join(base, 'plugin-state', 'personal-ledger.json'),
    JSON.stringify({ tag: `state:${tag}` })
  )
  writeFile(path.join(base, 'lattice-sync.json'), JSON.stringify({ tag: `sync:${tag}` }))
}

function seedProfile(root: string, key: string, tag: string): void {
  seedItems(profileDir(root, key), tag)
}

function tagOfRoot(root: string): string {
  const db = fs.readFileSync(path.join(root, 'RytenBenchDB', 'PG_VERSION'), 'utf-8')
  const state = JSON.parse(
    fs.readFileSync(path.join(root, 'plugin-state', 'personal-ledger.json'), 'utf-8')
  ) as { tag: string }
  const sync = JSON.parse(fs.readFileSync(path.join(root, 'lattice-sync.json'), 'utf-8')) as {
    tag: string
  }
  return `${db}|${state.tag}|${sync.tag}`
}

function tagOfProfile(root: string, key: string): string {
  const dir = profileDir(root, key)
  const db = fs.readFileSync(path.join(dir, 'RytenBenchDB', 'PG_VERSION'), 'utf-8')
  const state = JSON.parse(
    fs.readFileSync(path.join(dir, 'plugin-state', 'personal-ledger.json'), 'utf-8')
  ) as { tag: string }
  const sync = JSON.parse(fs.readFileSync(path.join(dir, 'lattice-sync.json'), 'utf-8')) as {
    tag: string
  }
  return `${db}|${state.tag}|${sync.tag}`
}

function hasRootItem(root: string, item: string): boolean {
  return fs.existsSync(path.join(root, item))
}

function writeSession(root: string, user: { id: string; username: string }, baseUrl: string): void {
  writeFile(
    profileSessionPath(root),
    JSON.stringify({
      version: 1,
      encrypted: false,
      refreshToken: 'refresh-token',
      baseUrl,
      user: { id: user.id, username: user.username, display_name: null, avatar: null },
      role: 'user',
      deviceId: 'dev-1',
      savedAt: Date.now()
    })
  )
}

console.log('profiles manager')

check('deriveProfileKey: 未登录 → anonymous', () => {
  assert.equal(deriveProfileKey({ loggedIn: false, userId: null }), ANONYMOUS_PROFILE)
})

check('deriveProfileKey: 同账号同基址稳定、换基址/换账号不同', () => {
  const a = deriveProfileKey({ loggedIn: true, userId: 'u1', baseUrl: 'http://a:8088' })
  assert.match(a, /^u-[0-9a-f]{16}$/)
  assert.equal(a, deriveProfileKey({ loggedIn: true, userId: 'u1', baseUrl: 'http://a:8088' }))
  assert.notEqual(a, deriveProfileKey({ loggedIn: true, userId: 'u1', baseUrl: 'http://b:8088' }))
  assert.notEqual(a, deriveProfileKey({ loggedIn: true, userId: 'u2', baseUrl: 'http://a:8088' }))
})

check('readSessionIdentity: 有 token 才算登录；坏文件不抛错', () => {
  const root = tempRoot()
  try {
    assert.deepEqual(readSessionIdentity(root), { loggedIn: false, userId: null })
    writeFile(profileSessionPath(root), '{not json')
    assert.deepEqual(readSessionIdentity(root), { loggedIn: false, userId: null })
    writeFile(
      profileSessionPath(root),
      JSON.stringify({ version: 1, refreshToken: '', user: { id: 'u1' }, baseUrl: 'x' })
    )
    assert.deepEqual(readSessionIdentity(root), { loggedIn: false, userId: null })
    writeSession(root, { id: 'u1', username: 'alice' }, 'http://a:8088')
    assert.deepEqual(readSessionIdentity(root), {
      loggedIn: true,
      userId: 'u1',
      username: 'alice',
      baseUrl: 'http://a:8088'
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('首次运行：根目录现有数据被当前 key 认领（不搬动、不丢）', () => {
  const root = tempRoot()
  try {
    seedItems(root, 'A')
    const keyA = deriveProfileKey({ loggedIn: true, userId: 'u1', baseUrl: 'http://a:8088' })
    const result = applyProfile(root, keyA, { loggedIn: true, userId: 'u1' })
    assert.equal(result.key, keyA)
    assert.equal(result.changed, true)
    assert.equal(result.claimedExisting, true)
    assert.equal(result.moved.length, 0)
    assert.equal(tagOfRoot(root), 'db:A|state:A|sync:A')
    assert.equal(readProfileMarker(root)?.key, keyA)
    // 再调一次是 no-op
    const again = applyProfile(root, keyA)
    assert.equal(again.changed, false)
    assert.equal(again.moved.length, 0)
    assert.equal(tagOfRoot(root), 'db:A|state:A|sync:A')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('A → B → A：三份数据完整对调，不串、不丢', () => {
  const root = tempRoot()
  const keyA = 'u-aaaaaaaaaaaaaaaa'
  const keyB = 'u-bbbbbbbbbbbbbbbb'
  try {
    seedItems(root, 'A')
    applyProfile(root, keyA)
    seedProfile(root, keyB, 'B')

    const toB = applyProfile(root, keyB)
    assert.equal(toB.from, keyA)
    assert.deepEqual([...toB.moved].sort(), [...PROFILE_ITEMS].sort())
    assert.equal(tagOfRoot(root), 'db:B|state:B|sync:B')
    assert.equal(tagOfProfile(root, keyA), 'db:A|state:A|sync:A')
    assert.equal(hasRootItem(root, 'RytenBenchDB'), true)

    const backToA = applyProfile(root, keyA)
    assert.equal(backToA.from, keyB)
    assert.equal(tagOfRoot(root), 'db:A|state:A|sync:A')
    assert.equal(tagOfProfile(root, keyB), 'db:B|state:B|sync:B')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('切到全新账号：根目录清空，旧账号数据完整休眠', () => {
  const root = tempRoot()
  const keyA = 'u-aaaaaaaaaaaaaaaa'
  const keyNew = 'u-cccccccccccccccc'
  try {
    seedItems(root, 'A')
    applyProfile(root, keyA)
    const result = applyProfile(root, keyNew)
    assert.equal(result.from, keyA)
    assert.equal(tagOfProfile(root, keyA), 'db:A|state:A|sync:A')
    for (const item of PROFILE_ITEMS) assert.equal(hasRootItem(root, item), false)
    assert.equal(readProfileMarker(root)?.key, keyNew)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('登出 → anonymous，再登录 → 原账号数据回来', () => {
  const root = tempRoot()
  const keyA = 'u-aaaaaaaaaaaaaaaa'
  try {
    seedItems(root, 'A')
    applyProfile(root, keyA)
    const logout = applyProfile(root, ANONYMOUS_PROFILE)
    assert.equal(logout.from, keyA)
    for (const item of PROFILE_ITEMS) assert.equal(hasRootItem(root, item), false)
    const login = applyProfile(root, keyA)
    assert.equal(login.from, ANONYMOUS_PROFILE)
    assert.equal(tagOfRoot(root), 'db:A|state:A|sync:A')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('崩溃恢复（stage=out，搬到一半）：重启后续做，数据不丢', () => {
  const root = tempRoot()
  const keyA = 'u-aaaaaaaaaaaaaaaa'
  const keyB = 'u-bbbbbbbbbbbbbbbb'
  try {
    seedItems(root, 'A')
    applyProfile(root, keyA)
    seedProfile(root, keyB, 'B')
    // 模拟：对调刚开始，DB 已搬进 A 容器，另外两项还在根目录，journal 停在 out
    fs.renameSync(
      path.join(root, 'RytenBenchDB'),
      path.join(profileDir(root, keyA), 'RytenBenchDB')
    )
    writeFile(
      profileJournalPath(root),
      JSON.stringify({ version: 1, from: keyA, to: keyB, stage: 'out', startedAt: Date.now() })
    )

    const result = applyProfile(root, keyB)
    assert.equal(result.recovered, true)
    assert.equal(tagOfRoot(root), 'db:B|state:B|sync:B')
    assert.equal(tagOfProfile(root, keyA), 'db:A|state:A|sync:A')
    assert.equal(fs.existsSync(profileJournalPath(root)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('崩溃恢复（stage=in，搬回一半）：不会把已搬回的数据又搬走', () => {
  const root = tempRoot()
  const keyA = 'u-aaaaaaaaaaaaaaaa'
  const keyB = 'u-bbbbbbbbbbbbbbbb'
  try {
    seedItems(root, 'A')
    applyProfile(root, keyA)
    seedProfile(root, keyB, 'B')
    // 模拟：A 已全部搬出，B 的 DB 已搬回根目录，其余还在 B 容器，journal 停在 in
    for (const item of PROFILE_ITEMS) {
      fs.renameSync(path.join(root, item), path.join(profileDir(root, keyA), item))
    }
    fs.renameSync(
      path.join(profileDir(root, keyB), 'RytenBenchDB'),
      path.join(root, 'RytenBenchDB')
    )
    writeFile(
      profileJournalPath(root),
      JSON.stringify({ version: 1, from: keyA, to: keyB, stage: 'in', startedAt: Date.now() })
    )

    const result = applyProfile(root, keyB)
    assert.equal(result.recovered, true)
    assert.equal(tagOfRoot(root), 'db:B|state:B|sync:B')
    assert.equal(tagOfProfile(root, keyA), 'db:A|state:A|sync:A')
    assert.equal(fs.existsSync(profileJournalPath(root)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('异常冲突：根目录与目标容器同名数据 → 多出来的一份进 .orphan，不覆盖', () => {
  const root = tempRoot()
  const keyA = 'u-aaaaaaaaaaaaaaaa'
  const keyB = 'u-bbbbbbbbbbbbbbbb'
  try {
    seedItems(root, 'A')
    applyProfile(root, keyA)
    seedProfile(root, keyB, 'B')
    // 人为制造异常：A 容器里也有一份旧 sync 文件
    writeFile(
      path.join(profileDir(root, keyA), 'lattice-sync.json'),
      JSON.stringify({ tag: 'sync:stale' })
    )
    writeFile(
      profileJournalPath(root),
      JSON.stringify({ version: 1, from: keyA, to: keyB, stage: 'out', startedAt: Date.now() })
    )

    const result = applyProfile(root, keyB)
    assert.equal(result.conflicts.includes('lattice-sync.json'), true)
    assert.equal(tagOfRoot(root), 'db:B|state:B|sync:B')
    assert.equal(tagOfProfile(root, keyA), 'db:A|state:A|sync:A')
    const orphanRoot = path.join(root, 'profiles', '.orphan')
    const orphanEntries = fs.readdirSync(orphanRoot)
    assert.equal(orphanEntries.length >= 1, true)
    const orphanFiles = fs.readdirSync(path.join(orphanRoot, orphanEntries[0]))
    assert.deepEqual(orphanFiles, ['lattice-sync.json'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('无关文件（会话 / 设置 / 插件包）永远留在根目录', () => {
  const root = tempRoot()
  const keyA = 'u-aaaaaaaaaaaaaaaa'
  try {
    writeFile(path.join(root, 'lattice-session.json'), '{"refreshToken":"t"}')
    writeFile(path.join(root, 'lattice-settings.json'), '{"baseUrl":"http://a"}')
    writeFile(path.join(root, 'plugins', 'personal-ledger', 'main.cjs'), 'module.exports={}')
    seedItems(root, 'A')
    applyProfile(root, keyA)
    applyProfile(root, ANONYMOUS_PROFILE)
    applyProfile(root, keyA)
    assert.equal(fs.existsSync(path.join(root, 'lattice-session.json')), true)
    assert.equal(fs.existsSync(path.join(root, 'lattice-settings.json')), true)
    assert.equal(fs.existsSync(path.join(root, 'plugins', 'personal-ledger', 'main.cjs')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('端到端：登录 A → 登出 → 登录 B → 回 A，按会话文件自动选对容器', () => {
  const root = tempRoot()
  try {
    writeSession(root, { id: 'alice', username: 'alice' }, 'http://a:8088')
    const keyA = deriveProfileKey(readSessionIdentity(root))
    seedItems(root, 'A')
    applyProfile(root, keyA, readSessionIdentity(root))
    assert.equal(tagOfRoot(root), 'db:A|state:A|sync:A')

    // 登出：会话文件被删 → anonymous
    fs.rmSync(profileSessionPath(root), { force: true })
    const keyAnon = deriveProfileKey(readSessionIdentity(root))
    assert.equal(keyAnon, ANONYMOUS_PROFILE)
    applyProfile(root, keyAnon, readSessionIdentity(root))
    for (const item of PROFILE_ITEMS) assert.equal(hasRootItem(root, item), false)

    // 登录 B（另一个账号 + 另一个基址）
    writeSession(root, { id: 'bob', username: 'bob' }, 'http://b:8088')
    const keyB = deriveProfileKey(readSessionIdentity(root))
    assert.notEqual(keyB, keyA)
    applyProfile(root, keyB, readSessionIdentity(root))
    for (const item of PROFILE_ITEMS) assert.equal(hasRootItem(root, item), false)

    // B 写了自己的数据后，再切回 A：三份数据各自完整
    seedItems(root, 'B')
    const back = applyProfile(root, keyA, {
      loggedIn: true,
      userId: 'alice',
      username: 'alice',
      baseUrl: 'http://a:8088'
    })
    assert.equal(back.from, keyB)
    assert.equal(tagOfRoot(root), 'db:A|state:A|sync:A')
    assert.equal(tagOfProfile(root, keyB), 'db:B|state:B|sync:B')
    assert.equal(readProfileMarker(root)?.key, keyA)
    assert.equal(fs.existsSync(profileMarkerPath(root)), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

console.log(`\nprofiles manager: ${checks} checks passed`)
