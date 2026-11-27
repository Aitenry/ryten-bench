CREATE TABLE "search_providers" (
	"provider" text PRIMARY KEY NOT NULL,
	"api_key_encrypted" text,
	"key_mask" text,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "search_providers_provider_check" CHECK ("search_providers"."provider" in ('builtin', 'deepseek', 'tavily'))
);
--> statement-breakpoint
CREATE TABLE "search_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"default_provider" text DEFAULT 'builtin' NOT NULL,
	"auto_fallback" boolean DEFAULT true NOT NULL,
	"include_content" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "search_settings_singleton_check" CHECK ("search_settings"."id" = 1),
	CONSTRAINT "search_settings_default_provider_check" CHECK ("search_settings"."default_provider" in ('builtin', 'deepseek', 'tavily'))
);
