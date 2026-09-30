ALTER TABLE `crawl_searches` ADD `preset` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `crawl_state` ADD `search_keywords` text;--> statement-breakpoint
ALTER TABLE `crawl_state` ADD `search_location` text;