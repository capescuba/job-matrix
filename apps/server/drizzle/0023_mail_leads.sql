CREATE TABLE `mail_leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`internet_message_id` text NOT NULL,
	`message_id` text NOT NULL,
	`received_at` text NOT NULL,
	`from_name` text,
	`from_addr` text,
	`subject` text NOT NULL,
	`web_link` text,
	`application_id` integer,
	`existing` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_leads_message` ON `mail_leads` (`internet_message_id`);--> statement-breakpoint
ALTER TABLE `mail_sync` ADD `leads_folder` text DEFAULT 'Job leads';--> statement-breakpoint
ALTER TABLE `mail_sync` ADD `leads_folder_found` integer;--> statement-breakpoint
ALTER TABLE `mail_sync` ADD `leads_added` integer DEFAULT 0 NOT NULL;