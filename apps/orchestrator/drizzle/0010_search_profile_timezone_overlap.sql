-- W5 (new sources): the search profile's time-zone overlap for remote boards ("Asia", "UTC+7 ±3h");
-- NULL = no filter. drizzle-kit's ADD COLUMN: no table rebuild, no trigger touched.
ALTER TABLE `search_profiles` ADD `timezone_overlap` text;
