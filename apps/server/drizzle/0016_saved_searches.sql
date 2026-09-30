CREATE TABLE `crawl_searches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`last_error` text,
	`last_count` integer,
	`last_matched` integer,
	`last_added` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `crawl_leads` ADD `search_id` integer REFERENCES crawl_searches(id);--> statement-breakpoint
ALTER TABLE `crawl_state` ADD `search_run_at` text;