CREATE TABLE "team_board" (
	"topic_id" integer PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"tasks" text NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "team_board" ADD CONSTRAINT "team_board_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."harness_topic"("id") ON DELETE cascade ON UPDATE no action;