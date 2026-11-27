CREATE TABLE "subagent_session" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" integer NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"prompt" text NOT NULL,
	"config" text NOT NULL,
	"messages" text NOT NULL,
	"conversation" text NOT NULL,
	"conversation_seq" integer DEFAULT 0 NOT NULL,
	"turn_counter" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"last_output" text,
	"inbox" text,
	"created_at" timestamp DEFAULT now(),
	"last_run_at" timestamp,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "subagent_session" ADD CONSTRAINT "subagent_session_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."harness_topic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_subagent_session_topic" ON "subagent_session" USING btree ("topic_id" int4_ops);