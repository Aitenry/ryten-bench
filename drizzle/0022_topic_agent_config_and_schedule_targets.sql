CREATE TABLE "topic_agent_config" (
	"topic_id" integer PRIMARY KEY NOT NULL,
	"tools" text,
	"skills" text,
	"mcp_tools" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "topic_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "target_mode" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "target_workspace_id" integer;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "target_memory_scope" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "agent_config" text;--> statement-breakpoint
ALTER TABLE "topic_agent_config" ADD CONSTRAINT "topic_agent_config_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."harness_topic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_target_mode_check" CHECK ("scheduled_tasks"."target_mode" is null or "scheduled_tasks"."target_mode" in ('chat', 'work', 'plugin'));