ALTER TABLE `jobs` ADD `posted_source` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posted_approx` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posted_raw` text;