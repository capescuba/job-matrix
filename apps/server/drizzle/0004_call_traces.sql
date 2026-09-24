ALTER TABLE `ai_usage` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `error` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `request_json` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `response_text` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `thinking_text` text;--> statement-breakpoint
ALTER TABLE `fit_assessments` ADD `usage_id` integer;