CREATE TABLE `prescreens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`verdict` text NOT NULL,
	`score` real,
	`reason` text,
	`model` text NOT NULL,
	`usage_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prescreens_app` ON `prescreens` (`application_id`);