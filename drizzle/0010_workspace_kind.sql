-- 0010：工作区「种类」列（user / plugin / chat）。
-- 用途见 src/main/database/schema/workspace.ts：侧栏「对话」模式的工作目录与插件工作区
-- 都必须能从行本身认出来（原来靠「路径是不是插件根的直接子目录」现算，插件根一改配置就漂）。
-- 老数据一律按默认值 'user' 算；启动时 migrateWorkspaceData 会把历史上那批插件工作区
-- 就地分类成 'plugin'（那里能读到插件存放路径，SQL 里读不到）。
ALTER TABLE "workspace" ADD COLUMN "kind" text DEFAULT 'user';--> statement-breakpoint
CREATE INDEX "idx_workspace_kind" ON "workspace" USING btree ("kind" text_ops);
