-- PM3 S4 (F4): a saved preset is a shipped workflow plus stored params (workflows.preset_json), and
-- a run remembers the preset Lead started it from (runs.preset_name). drizzle-kit's ADD COLUMN: no
-- table rebuild, no trigger touched.
ALTER TABLE `runs` ADD `preset_name` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `preset_json` text;
