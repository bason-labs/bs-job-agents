CREATE TABLE `guidance_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cv_version_id` integer NOT NULL,
	`snapshot` integer,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`cv_version_id`) REFERENCES `cv_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guidance_reviews_cv_idx` ON `guidance_reviews` (`cv_version_id`);--> statement-breakpoint
CREATE TABLE `guidance_rule_sets` (
	`snapshot` integer PRIMARY KEY NOT NULL,
	`run_id` integer,
	`rule_set_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guidance_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`turned_off_json` text DEFAULT '[]' NOT NULL,
	`last_discovery_at` text,
	`lock_run_id` integer,
	`lock_at` text
);
--> statement-breakpoint
-- AD-10: rule-set snapshots are append-only; a refresh adds a snapshot, never edits one.
CREATE TRIGGER `guidance_rule_sets_no_update` BEFORE UPDATE ON `guidance_rule_sets`
BEGIN
	SELECT RAISE(ABORT, 'guidance rule set snapshots are append-only (AD-10)');
END;
--> statement-breakpoint
CREATE TRIGGER `guidance_rule_sets_no_delete` BEFORE DELETE ON `guidance_rule_sets`
BEGIN
	SELECT RAISE(ABORT, 'guidance rule set snapshots are append-only (AD-10)');
END;
