-- Some feeds (e.g. careers.docusign.com's schema.org data) publish a salary of 0 to mean
-- "not provided". Those were stored as a $0-$0 range and failed the pay floor. Clear them so
-- the range is read from the job description instead.
UPDATE `jobs` SET `salary_min` = NULL WHERE `salary_min` <= 0;--> statement-breakpoint
UPDATE `jobs` SET `salary_max` = NULL WHERE `salary_max` <= 0;
