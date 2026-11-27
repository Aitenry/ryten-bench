/**
 * 数据库迁移全量回归（离线，PGlite 内存库）。
 *
 * 覆盖：
 * 1. 23 个迁移能在**全新空库**上完整应用（表数 / 关键索引 / 约束）；
 * 2. 重复执行 migrate 幂等（drizzle 迁移表记账）；
 * 3. **历史脏数据场景**：先只应用 0000-0022，插入重复的图谱关系，再应用 0023
 *    （去重 DELETE + 唯一约束）——保证老用户升级不会因 UNIQUE 约束失败而启动中断。
 *
 * 跑法：`node --no-warnings tests/database-migrations.test.mts`
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fullMigrations = path.join(root, 'drizzle')

// ── 1. 全新库完整迁移 ─────────────────────────────────────────────────
const fresh = new PGlite('memory://')
await migrate(drizzle(fresh), { migrationsFolder: fullMigrations })

const tables = await fresh.query<{ tablename: string }>(
  `select tablename from pg_tables where schemaname = 'public' order by tablename`
)
// 基线 0000 建了 34 张表（含后续更名前的历史表），schema 当前声明 30 张；
// 迁移只增不删，所以这里断言下限 + 关键表存在。
assert.ok(tables.rows.length >= 30, `expected at least 30 public tables, got ${tables.rows.length}`)
for (const name of ['graph_relations', 'graph_entities', 'harness_topic', 'documents']) {
  assert.ok(
    tables.rows.some((row) => row.tablename === name),
    `missing table ${name}`
  )
}

const constraints = await fresh.query<{ conname: string; contype: string }>(
  `select conname, contype from pg_constraint where conname = 'uq_graph_relations_key'`
)
assert.equal(constraints.rows.length, 1, '0023 unique constraint must exist')
assert.equal(constraints.rows[0].contype, 'u')

const applied = await fresh.query<{ n: number }>(
  `select count(*)::int as n from drizzle.__drizzle_migrations`
)
assert.equal(applied.rows[0].n, 24, `expected 24 applied migrations, got ${applied.rows[0].n}`)

// 幂等：再跑一次不报错、迁移数不变
await migrate(drizzle(fresh), { migrationsFolder: fullMigrations })
const appliedAgain = await fresh.query<{ n: number }>(
  `select count(*)::int as n from drizzle.__drizzle_migrations`
)
assert.equal(appliedAgain.rows[0].n, 24)
await fresh.close()

// ── 2. 历史脏数据升级（0000-0022 → 0023） ─────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-migrations-'))
try {
  const legacyDir = path.join(tmp, 'drizzle-legacy')
  fs.mkdirSync(path.join(legacyDir, 'meta'), { recursive: true })
  const journal = JSON.parse(
    fs.readFileSync(path.join(fullMigrations, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ idx: number; tag: string }> }
  const legacyEntries = journal.entries.filter((entry) => entry.idx <= 22)
  fs.writeFileSync(
    path.join(legacyDir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: legacyEntries }, null, 2)
  )
  for (const entry of legacyEntries) {
    fs.copyFileSync(
      path.join(fullMigrations, `${entry.tag}.sql`),
      path.join(legacyDir, `${entry.tag}.sql`)
    )
  }

  const legacy = new PGlite('memory://')
  await migrate(drizzle(legacy), { migrationsFolder: legacyDir })
  const before = await legacy.query<{ n: number }>(
    `select count(*)::int as n from drizzle.__drizzle_migrations`
  )
  assert.equal(before.rows[0].n, 23, 'legacy DB must be at migration 0022')

  const wiki = await legacy.query<{ id: number }>(
    `insert into wiki (title) values ('migration-test') returning id`
  )
  const wikiId = wiki.rows[0].id
  const entities = await legacy.query<{ id: number }>(
    `insert into graph_entities (wiki_id, name, type) values ($1, 'A', 'concept'), ($1, 'B', 'concept') returning id`,
    [wikiId]
  )
  const [a, b] = entities.rows.map((row) => row.id)
  // 同一业务键的两行历史重复数据
  await legacy.query(
    `insert into graph_relations (wiki_id, source_id, target_id, relation_type, description)
     values ($1, $2, $3, 'related', 'old'), ($1, $2, $3, 'related', 'new')`,
    [wikiId, a, b]
  )

  // 应用完整迁移目录：0023 先删重复再加唯一约束，不应失败
  await migrate(drizzle(legacy), { migrationsFolder: fullMigrations })
  const after = await legacy.query<{ n: number }>(
    `select count(*)::int as n from drizzle.__drizzle_migrations`
  )
  assert.equal(after.rows[0].n, 24)
  const remaining = await legacy.query<{ n: number }>(
    `select count(*)::int as n from graph_relations where relation_type = 'related'`
  )
  assert.equal(remaining.rows[0].n, 1, 'duplicate relations must be collapsed to one row')
  await legacy.close()
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('database-migrations: all assertions passed')
