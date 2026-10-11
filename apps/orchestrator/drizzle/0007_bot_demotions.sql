CREATE TABLE `bot_demotions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot_name` text NOT NULL,
	`from_level` integer NOT NULL,
	`to_level` integer NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`run_id` integer,
	`task_id` integer,
	`created_at` text NOT NULL,
	`restored_at` text,
	FOREIGN KEY (`bot_name`) REFERENCES `bots`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `bot_demotions_bot_idx` ON `bot_demotions` (`bot_name`,`created_at`);