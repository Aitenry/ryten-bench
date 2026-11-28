-- 0008: model-level "reasoning effort" column; values lowercase across protocols. Null = unset,
-- no parameter is sent and the model default applies. Allowed levels come from the model profile's
-- capabilities.reasoning_effort_levels, mapped by the main process per protocol family into
-- provider fields: OpenAI-compatible reasoning_effort / OpenRouter reasoning.effort / Anthropic
--  output_config.effort / Gemini thinkingConfig.thinkingLevel / Ollama think).
ALTER TABLE "llm_providers" ADD COLUMN "reasoning_effort" text;
