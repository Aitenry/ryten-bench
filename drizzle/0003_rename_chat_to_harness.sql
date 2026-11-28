-- chat → harness: the four dialogue tables renamed with indexes, FKs, unique and CHECK constraints.
--
-- RENAME only, no table rebuild: the topics, messages, goals, and usage data already in the local
-- PGlite data directory (userData/RytenBenchDB) are preserved as-is. Foreign keys follow
-- the renamed tables by object OID, but index/constraint names do not, so each is renamed below.
ALTER TABLE "chat_topic" RENAME TO "harness_topic";--> statement-breakpoint
ALTER TABLE "harness_topic" RENAME CONSTRAINT "chat_topic_workspace_id_fkey" TO "harness_topic_workspace_id_fkey";--> statement-breakpoint
ALTER INDEX "chat_topic_pkey" RENAME TO "harness_topic_pkey";--> statement-breakpoint
ALTER INDEX "idx_chat_topic_workspace" RENAME TO "idx_harness_topic_workspace";--> statement-breakpoint
ALTER INDEX "idx_chat_topic_updated_at" RENAME TO "idx_harness_topic_updated_at";--> statement-breakpoint
ALTER TABLE "chat_dialogue" RENAME TO "harness_dialogue";--> statement-breakpoint
ALTER TABLE "harness_dialogue" RENAME CONSTRAINT "chat_dialogue_topic_id_fkey" TO "harness_dialogue_topic_id_fkey";--> statement-breakpoint
ALTER TABLE "harness_dialogue" RENAME CONSTRAINT "chat_dialogue_role_check" TO "harness_dialogue_role_check";--> statement-breakpoint
ALTER INDEX "chat_dialogue_pkey" RENAME TO "harness_dialogue_pkey";--> statement-breakpoint
ALTER INDEX "idx_chat_dialogue_topic" RENAME TO "idx_harness_dialogue_topic";--> statement-breakpoint
ALTER INDEX "idx_chat_dialogue_topic_created" RENAME TO "idx_harness_dialogue_topic_created";--> statement-breakpoint
ALTER TABLE "chat_goals" RENAME TO "harness_goals";--> statement-breakpoint
ALTER TABLE "harness_goals" RENAME CONSTRAINT "chat_goals_phase_check" TO "harness_goals_phase_check";--> statement-breakpoint
ALTER INDEX "chat_goals_pkey" RENAME TO "harness_goals_pkey";--> statement-breakpoint
ALTER INDEX "idx_chat_goals_phase" RENAME TO "idx_harness_goals_phase";--> statement-breakpoint
ALTER TABLE "chat_dialogue_usage" RENAME TO "harness_dialogue_usage";--> statement-breakpoint
ALTER TABLE "harness_dialogue_usage" RENAME CONSTRAINT "chat_dialogue_usage_dialogue_id_key" TO "harness_dialogue_usage_dialogue_id_key";--> statement-breakpoint
ALTER TABLE "harness_dialogue_usage" RENAME CONSTRAINT "chat_dialogue_usage_workspace_id_fkey" TO "harness_dialogue_usage_workspace_id_fkey";--> statement-breakpoint
ALTER TABLE "harness_dialogue_usage" RENAME CONSTRAINT "chat_dialogue_usage_topic_id_fkey" TO "harness_dialogue_usage_topic_id_fkey";--> statement-breakpoint
ALTER TABLE "harness_dialogue_usage" RENAME CONSTRAINT "chat_dialogue_usage_dialogue_id_fkey" TO "harness_dialogue_usage_dialogue_id_fkey";--> statement-breakpoint
ALTER INDEX "chat_dialogue_usage_pkey" RENAME TO "harness_dialogue_usage_pkey";--> statement-breakpoint
ALTER INDEX "idx_chat_dialogue_usage_topic" RENAME TO "idx_harness_dialogue_usage_topic";--> statement-breakpoint
ALTER INDEX "idx_chat_dialogue_usage_workspace" RENAME TO "idx_harness_dialogue_usage_workspace";--> statement-breakpoint
-- The above covers the indexes and constraints declared in code. PostgreSQL also creates an
-- implicit catalog constraint per NOT NULL column (chat_topic_title_not_null etc.), whose names
-- are system-generated and undeclared, so the sweep below clears chat_ prefixes catalog-wide
-- rather than hardcoding a list.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname, conrelid::regclass AS tbl
    FROM pg_constraint
    WHERE contype = 'n' AND connamespace = 'public'::regnamespace AND conname LIKE '%chat\_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
      r.tbl, r.conname, replace(r.conname, 'chat_', 'harness_')
    );
  END LOOP;
END $$;
