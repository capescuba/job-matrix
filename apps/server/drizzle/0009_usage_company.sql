ALTER TABLE `ai_usage` ADD `company_id` integer;--> statement-breakpoint
-- Backfill past calls: a research brief points at the call that made it, and a fit call reaches
-- its company through its job (when the job still exists).
UPDATE `ai_usage` SET `company_id` = (SELECT `company_id` FROM `company_research` WHERE `usage_id` = `ai_usage`.`id`) WHERE `company_id` IS NULL;--> statement-breakpoint
UPDATE `ai_usage` SET `company_id` = (SELECT j.`company_id` FROM `applications` a JOIN `jobs` j ON j.`id` = a.`job_id` WHERE a.`id` = `ai_usage`.`application_id`) WHERE `company_id` IS NULL AND `application_id` IS NOT NULL;
