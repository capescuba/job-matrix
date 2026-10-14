ALTER TABLE `mail_leads` ADD `conversation_id` text;--> statement-breakpoint
CREATE INDEX `mail_leads_conversation` ON `mail_leads` (`conversation_id`);