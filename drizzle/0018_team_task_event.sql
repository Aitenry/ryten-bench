CREATE TABLE "team_task_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"topic_id" integer NOT NULL,
	"task_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"subject" text NOT NULL,
	"task_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "team_task_event" ADD CONSTRAINT "team_task_event_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."harness_topic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_team_task_event_topic" ON "team_task_event" USING btree ("topic_id" int4_ops,"id" int4_ops);