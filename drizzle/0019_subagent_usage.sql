ALTER TABLE "subagent_session" ADD COLUMN "usage_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subagent_session" ADD COLUMN "usage_output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subagent_session" ADD COLUMN "usage_total_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subagent_session" ADD COLUMN "usage_calls" integer DEFAULT 0 NOT NULL;