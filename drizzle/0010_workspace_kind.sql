-- 0010: workspace "kind" column (user / plugin / chat); see src/main/database/schema/workspace.ts.
-- The sidebar "dialogue" mode working directory and plugin workspaces must both be identifiable
-- from the row itself (previously derived from "is the path a direct child of the plugin root",
-- which drifted with root config). Old rows default to 'user'; at startup migrateWorkspaceData
-- reclassifies old plugin workspaces as 'plugin' (it reads the plugin path, SQL cannot).
ALTER TABLE "workspace" ADD COLUMN "kind" text DEFAULT 'user';--> statement-breakpoint
CREATE INDEX "idx_workspace_kind" ON "workspace" USING btree ("kind" text_ops);
