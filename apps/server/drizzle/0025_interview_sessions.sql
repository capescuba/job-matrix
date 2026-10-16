CREATE TABLE `interview_hints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`segment_id` integer,
	`trigger` text NOT NULL,
	`hint` text NOT NULL,
	`usage_id` integer,
	`at_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `interview_segments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `interview_hints_session` ON `interview_hints` (`session_id`);--> statement-breakpoint
CREATE TABLE `interview_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`speaker` text NOT NULL,
	`text` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_segments_session` ON `interview_segments` (`session_id`);--> statement-breakpoint
CREATE TABLE `interview_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`round` text NOT NULL,
	`coach_model` text NOT NULL,
	`transcriber` text,
	`started_at` text,
	`ended_at` text,
	`record_audio` integer DEFAULT true NOT NULL,
	`audio_file` text,
	`audio_ms` integer,
	`mic_device` text,
	`output_device` text,
	`prep` text,
	`prep_usage_id` integer,
	`summary` text,
	`debrief_usage_id` integer,
	`activity_id` integer,
	`asked_questions` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_sessions_app` ON `interview_sessions` (`application_id`);