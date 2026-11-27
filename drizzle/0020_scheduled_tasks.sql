CREATE TABLE "scheduled_task_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"status" text NOT NULL,
	"ran_at" timestamp NOT NULL,
	"detail" text,
	CONSTRAINT "scheduled_task_runs_status_check" CHECK ("scheduled_task_runs"."status" in ('completed', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" integer,
	"topic_id" integer NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"when_kind" text NOT NULL,
	"when_json" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"last_status" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "scheduled_tasks_when_kind_check" CHECK ("scheduled_tasks"."when_kind" in ('once', 'every', 'daily')),
	CONSTRAINT "scheduled_tasks_last_status_check" CHECK ("scheduled_tasks"."last_status" is null or "scheduled_tasks"."last_status" in ('completed', 'cancelled', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD CONSTRAINT "scheduled_task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."harness_topic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_runs_task" ON "scheduled_task_runs" USING btree ("task_id" text_ops,"ran_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_topic" ON "scheduled_tasks" USING btree ("topic_id" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_next_run" ON "scheduled_tasks" USING btree ("next_run_at" timestamp_ops);