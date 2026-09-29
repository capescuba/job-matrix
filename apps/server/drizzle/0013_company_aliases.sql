CREATE TABLE `company_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`alias` text NOT NULL,
	`alias_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_aliases_key` ON `company_aliases` (`alias_key`);--> statement-breakpoint
CREATE INDEX `company_aliases_company` ON `company_aliases` (`company_id`);