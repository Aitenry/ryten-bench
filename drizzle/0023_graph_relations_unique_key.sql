-- Business unique key for graph relations (performance and correctness).
--
-- Background: batchUpsertRelations did a SELECT + UPDATE/INSERT per relation, so graph building
-- became 2N serial statements on single-connection PGlite. One INSERT ... ON CONFLICT needs a
-- database-level unique constraint, so old duplicate rows are removed first (smallest id wins).
--
-- Why DELETE first: ADD CONSTRAINT fails while duplicates exist, aborting the startup migration.
-- Rollback: ALTER TABLE "graph_relations" DROP CONSTRAINT IF EXISTS "uq_graph_relations_key";
DELETE FROM "graph_relations" a
USING "graph_relations" b
WHERE a."id" > b."id"
  AND a."wiki_id" = b."wiki_id"
  AND a."source_id" = b."source_id"
  AND a."target_id" = b."target_id"
  AND a."relation_type" = b."relation_type";
--> statement-breakpoint
ALTER TABLE "graph_relations" ADD CONSTRAINT "uq_graph_relations_key" UNIQUE("wiki_id","source_id","target_id","relation_type");
