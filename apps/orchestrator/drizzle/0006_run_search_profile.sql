-- Phase 2 (W2a): a run pins the Search Profile version row it started with, so it keeps that
-- version after later edits (UC-21b). drizzle-kit's ADD COLUMN: no table rebuild, no trigger touched.
ALTER TABLE `runs` ADD `search_profile_id` integer REFERENCES search_profiles(id);
