ALTER TABLE "scheduled_task_runs" ALTER COLUMN "ran_at" SET DATA TYPE timestamp with time zone USING "ran_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "next_run_at" SET DATA TYPE timestamp with time zone USING "next_run_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "last_run_at" SET DATA TYPE timestamp with time zone USING "last_run_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "updated_at" SET DEFAULT now();
