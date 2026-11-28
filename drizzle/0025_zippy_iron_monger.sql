ALTER TABLE "scheduled_task_runs" ADD COLUMN "topic_id" integer;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "dialogue_id" integer;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "usage_json" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "steps_json" text;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD COLUMN "artifacts_json" text;