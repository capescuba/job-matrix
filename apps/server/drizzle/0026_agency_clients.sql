CREATE TABLE `client_lookups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`source` text NOT NULL,
	`result` text NOT NULL,
	`model` text,
	`usage_id` integer,
	`cost_usd` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_lookups_job` ON `client_lookups` (`job_id`);--> statement-breakpoint
ALTER TABLE `companies` ADD `is_agency` integer;