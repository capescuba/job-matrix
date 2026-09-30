CREATE TABLE `crawl_leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer,
	`url` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`remote_type` text,
	`salary_min` integer,
	`salary_max` integer,
	`posted_at` text,
	`verdict` text NOT NULL,
	`reason` text,
	`model` text,
	`usage_id` integer,
	`application_id` integer,
	`decided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `crawl_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crawl_leads_url` ON `crawl_leads` (`url`);--> statement-breakpoint
CREATE INDEX `crawl_leads_verdict` ON `crawl_leads` (`verdict`);--> statement-breakpoint
CREATE TABLE `crawl_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`company_name` text NOT NULL,
	`slug` text NOT NULL,
	`board_url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_checked_at` text,
	`last_error` text,
	`last_count` integer,
	`last_matched` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crawl_sources_board` ON `crawl_sources` (`kind`,`slug`);--> statement-breakpoint
CREATE TABLE `crawl_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_minutes` integer DEFAULT 0 NOT NULL,
	`title_include` text,
	`title_exclude` text,
	`locations` text,
	`last_run_at` text,
	`last_error` text,
	`boards` integer DEFAULT 0 NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`matched` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`filtered` integer DEFAULT 0 NOT NULL
);
