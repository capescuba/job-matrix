-- Jobs from Indeed, Glassdoor, ZipRecruiter and Dice were labelled "Company site", since the
-- source guess didn't know those sites. Relabel them by address; a source you chose stays.
UPDATE `jobs` SET `source` = 'Indeed' WHERE `source` = 'Company site' AND lower(`url`) LIKE '%indeed.com%';--> statement-breakpoint
UPDATE `jobs` SET `source` = 'Glassdoor' WHERE `source` = 'Company site' AND lower(`url`) LIKE '%glassdoor.%';--> statement-breakpoint
UPDATE `jobs` SET `source` = 'ZipRecruiter' WHERE `source` = 'Company site' AND lower(`url`) LIKE '%ziprecruiter.com%';--> statement-breakpoint
UPDATE `jobs` SET `source` = 'Dice' WHERE `source` = 'Company site' AND lower(`url`) LIKE '%dice.com%';
