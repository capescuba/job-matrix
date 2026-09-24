-- Some careers sites (e.g. GitHub's) fill address fields with "UNAVAILABLE". Locations made only
-- of that filler (e.g. "UNAVAILABLE, UNAVAILABLE") are cleared.
UPDATE `jobs` SET `location` = NULL
WHERE upper(`location`) LIKE '%UNAVAILABLE%'
  AND trim(replace(replace(upper(`location`), 'UNAVAILABLE', ''), ',', '')) = '';
