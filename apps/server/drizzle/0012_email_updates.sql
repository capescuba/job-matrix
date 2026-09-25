CREATE TABLE `email_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`received_at` text NOT NULL,
	`from_name` text,
	`from_addr` text,
	`subject` text NOT NULL,
	`web_link` text,
	`excerpt` text,
	`kind` text NOT NULL,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`evidence` text,
	`company_name` text,
	`job_title` text,
	`company_id` integer,
	`application_id` integer,
	`matched_by` text,
	`suggested_status` text,
	`suggested_next_action` text,
	`classified_by` text DEFAULT 'rules' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`activity_id` integer,
	`usage_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_updates_message` ON `email_updates` (`message_id`);--> statement-breakpoint
CREATE INDEX `email_updates_state` ON `email_updates` (`state`);--> statement-breakpoint
CREATE INDEX `email_updates_app` ON `email_updates` (`application_id`);--> statement-breakpoint
CREATE TABLE `mail_sync` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_minutes` integer DEFAULT -1 NOT NULL,
	`watermark` text,
	`last_sync_at` text,
	`last_error` text,
	`scanned` integer DEFAULT 0 NOT NULL,
	`found` integer DEFAULT 0 NOT NULL
);
