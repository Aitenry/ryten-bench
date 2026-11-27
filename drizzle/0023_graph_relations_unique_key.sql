-- 图谱关系业务唯一键（性能/正确性审计 P01/P08）
--
-- 背景：batchUpsertRelations 此前是「每条关系先 SELECT 再 UPDATE/INSERT」，
-- 在单连接 PGlite 上把图构建放大成 2N 次串行语句。改成一条 INSERT ... ON CONFLICT
-- 需要数据库层的唯一约束；上线前先把历史重复行清掉（保留 id 最小的那一行，即最早写入的）。
--
-- 为什么先 DELETE：直接 ADD CONSTRAINT 在存在重复行时会失败，导致应用启动迁移中断。
-- 可回滚：ALTER TABLE "graph_relations" DROP CONSTRAINT IF EXISTS "uq_graph_relations_key";
DELETE FROM "graph_relations" a
USING "graph_relations" b
WHERE a."id" > b."id"
  AND a."wiki_id" = b."wiki_id"
  AND a."source_id" = b."source_id"
  AND a."target_id" = b."target_id"
  AND a."relation_type" = b."relation_type";
--> statement-breakpoint
ALTER TABLE "graph_relations" ADD CONSTRAINT "uq_graph_relations_key" UNIQUE("wiki_id","source_id","target_id","relation_type");
