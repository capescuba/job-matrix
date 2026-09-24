CREATE TABLE `fit_gaps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`assessment_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`theme` text NOT NULL,
	`severity` text NOT NULL,
	`known_gap` integer DEFAULT false NOT NULL,
	`detail` text,
	FOREIGN KEY (`assessment_id`) REFERENCES `fit_assessments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fit_gaps_theme` ON `fit_gaps` (`theme`);--> statement-breakpoint
CREATE INDEX `fit_gaps_assessment` ON `fit_gaps` (`assessment_id`);--> statement-breakpoint
ALTER TABLE `fit_assessments` ADD `gate` text DEFAULT 'pass' NOT NULL;--> statement-breakpoint
ALTER TABLE `fit_assessments` ADD `gate_reasons` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posting_status` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posting_checked_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posting_note` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `min_base` integer;--> statement-breakpoint
ALTER TABLE `profile` ADD `must_haves` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `deal_breakers` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `strong_pluses` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `nice_to_haves` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `known_gaps` text;