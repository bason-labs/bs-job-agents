CREATE TABLE `skill_repair_sources` (
	`source` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`paused_at` text
);
--> statement-breakpoint
CREATE TABLE `skill_repairs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`task_id` integer,
	`repair_task_id` integer,
	`validation_task_id` integer,
	`draft_md` text,
	`other_changes_json` text DEFAULT '[]' NOT NULL,
	`previous_md` text,
	`reason` text,
	`manual` integer DEFAULT false NOT NULL,
	`restored_at` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT "skill_repairs_status_check" CHECK("status" IS NULL OR "status" IN ('queued', 'drafting', 'validating', 'adopting', 'adopted', 'not_adopted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_repairs_active_source_uq` ON `skill_repairs` (`source`) WHERE status IN ('queued', 'drafting', 'validating', 'adopting');--> statement-breakpoint
CREATE INDEX `skill_repairs_source_idx` ON `skill_repairs` (`source`,`id`);--> statement-breakpoint
CREATE TABLE `source_api_health` (
	`source` text PRIMARY KEY NOT NULL,
	`broken_since` text,
	`last_reason` text,
	`updated_at` text NOT NULL
);
