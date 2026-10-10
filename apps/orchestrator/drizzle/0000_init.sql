CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`cv_version_id` integer,
	`submitted_at` text,
	`status` text NOT NULL,
	`origin` text DEFAULT 'app' NOT NULL,
	`status_history_json` text NOT NULL,
	`reapply` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cv_version_id`) REFERENCES `cv_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "applications_status_check" CHECK("status" IS NULL OR "status" IN ('approved', 'paused', 'submitted', 'needs_check', 'failed', 'interviewing', 'offer', 'rejected', 'withdrawn', 'no_response')),
	CONSTRAINT "applications_origin_check" CHECK("origin" IS NULL OR "origin" IN ('app', 'imported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_job_uq` ON `applications` (`job_id`) WHERE "reapply" = 0;--> statement-breakpoint
CREATE INDEX `applications_status_idx` ON `applications` (`status`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`token` text PRIMARY KEY NOT NULL,
	`job_id` integer NOT NULL,
	`cv_version_id` integer NOT NULL,
	`allowed_domains_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cv_version_id`) REFERENCES `cv_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approvals_job_idx` ON `approvals` (`job_id`);--> statement-breakpoint
CREATE TABLE `bots` (
	`name` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`engine` text NOT NULL,
	`model` text,
	`trust_level` integer NOT NULL,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	CONSTRAINT "bots_engine_check" CHECK("engine" IS NULL OR "engine" IN ('claude', 'codex')),
	CONSTRAINT "bots_trust_level_check" CHECK("trust_level" IS NULL OR "trust_level" IN (0, 1, 2))
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`website` text,
	`profile_json` text,
	`confidence` text,
	`researched_at` text,
	CONSTRAINT "companies_confidence_check" CHECK("confidence" IS NULL OR "confidence" IN ('normal', 'low_confidence'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_name_key_uq` ON `companies` (`name_key`);--> statement-breakpoint
CREATE TABLE `cv_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`language` text NOT NULL,
	`round` integer NOT NULL,
	`tailored_json` text,
	`figma_frame_url` text,
	`pdf_path` text,
	`pdf_sha256` text,
	`master_version` integer,
	`prompt_version` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cv_versions_language_check" CHECK("language" IS NULL OR "language" IN ('EN', 'VI'))
);
--> statement-breakpoint
CREATE INDEX `cv_versions_job_idx` ON `cv_versions` (`job_id`,`language`,`round`);--> statement-breakpoint
CREATE TABLE `engine_state` (
	`engine` text PRIMARY KEY NOT NULL,
	`paused_until` text,
	`reason` text,
	CONSTRAINT "engine_state_engine_check" CHECK("engine" IS NULL OR "engine" IN ('claude', 'codex'))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`run_id` integer,
	`task_id` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_run_idx` ON `events` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`path` text NOT NULL,
	`application_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_snapshots` (
	`application_id` integer PRIMARY KEY NOT NULL,
	`captured_at` text NOT NULL,
	`url` text,
	`title` text,
	`company` text,
	`salary_text` text,
	`jd_text` text,
	`page_screenshot_path` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`url` text NOT NULL,
	`canonical_url` text NOT NULL,
	`dedupe_hash` text NOT NULL,
	`title` text NOT NULL,
	`company_id` integer NOT NULL,
	`location` text,
	`salary_text` text,
	`language` text,
	`jd_text` text,
	`fit_score` integer,
	`fit_reasons_json` text,
	`gaps_json` text,
	`status` text DEFAULT 'new' NOT NULL,
	`skip_reason` text,
	`skip_note` text,
	`posted_at` text,
	`first_seen_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_status_check" CHECK("status" IS NULL OR "status" IN ('new', 'below_threshold', 'selected', 'reviewing', 'approved', 'applied', 'skipped')),
	CONSTRAINT "jobs_skip_reason_check" CHECK("skip_reason" IS NULL OR "skip_reason" IN ('salary_low', 'outsourcing', 'location', 'tech_mismatch', 'company_culture', 'seniority', 'other')),
	CONSTRAINT "jobs_fit_score_check" CHECK("fit_score" IS NULL OR ("fit_score" BETWEEN 0 AND 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_canonical_url_uq` ON `jobs` (`canonical_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_hash_uq` ON `jobs` (`dedupe_hash`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company_id`);--> statement-breakpoint
CREATE TABLE `memory_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot_name` text NOT NULL,
	`run_id` integer,
	`task_id` integer,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bot_name`) REFERENCES `bots`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memory_changes_bot_idx` ON `memory_changes` (`bot_name`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` integer NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`mentions_json` text NOT NULL,
	`run_refs_json` text NOT NULL,
	`meta_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_room_idx` ON `messages` (`room_id`,`id`);--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot_name` text NOT NULL,
	`version` integer NOT NULL,
	`role_md_hash` text NOT NULL,
	`role_md_text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bot_name`) REFERENCES `bots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_versions_bot_version_uq` ON `prompt_versions` (`bot_name`,`version`);--> statement-breakpoint
CREATE TABLE `qa_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cv_version_id` integer NOT NULL,
	`total` integer NOT NULL,
	`scores_json` text NOT NULL,
	`hard_fails_json` text NOT NULL,
	`fixes_json` text NOT NULL,
	`injection_suspected` integer DEFAULT false NOT NULL,
	`passed` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`cv_version_id`) REFERENCES `cv_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `qa_reviews_cv_idx` ON `qa_reviews` (`cv_version_id`);--> statement-breakpoint
CREATE TABLE `room_members` (
	`room_id` integer NOT NULL,
	`bot_name` text NOT NULL,
	PRIMARY KEY(`room_id`, `bot_name`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_name`) REFERENCES `bots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`bot_name` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bot_name`) REFERENCES `bots`(`name`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rooms_kind_check" CHECK("kind" IS NULL OR "kind" IN ('lead', 'consult', 'group'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_name_uq` ON `rooms` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_consult_bot_uq` ON `rooms` (`bot_name`) WHERE "kind" = 'consult';--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_single_lead_uq` ON `rooms` (`kind`) WHERE "kind" = 'lead';--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_name` text NOT NULL,
	`workflow_version` integer NOT NULL,
	`trigger` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`schedule_id` integer,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_trigger_check" CHECK("trigger" IS NULL OR "trigger" IN ('chat', 'schedule', 'link')),
	CONSTRAINT "runs_status_check" CHECK("status" IS NULL OR "status" IN ('running', 'waiting', 'paused', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_schedule_idx` ON `runs` (`schedule_id`);--> statement-breakpoint
CREATE INDEX `runs_created_idx` ON `runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `saved_answers` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`answer` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cron` text NOT NULL,
	`workflow_name` text NOT NULL,
	`search_profile_id` integer,
	`params_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_id` integer,
	`next_run_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`search_profile_id`) REFERENCES `search_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `schedules_deleted_idx` ON `schedules` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `search_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`roles_json` text NOT NULL,
	`locations_json` text NOT NULL,
	`work_modes_json` text NOT NULL,
	`min_salary` real,
	`currency` text,
	`seniority_json` text NOT NULL,
	`sources_json` text NOT NULL,
	`include_keywords_json` text NOT NULL,
	`exclude_keywords_json` text NOT NULL,
	`exclude_companies_json` text NOT NULL,
	`company_types_json` text NOT NULL,
	`languages_json` text NOT NULL,
	`max_jobs` integer DEFAULT 5 NOT NULL,
	`fit_threshold` integer DEFAULT 60 NOT NULL,
	`salary_policy` text DEFAULT 'blank_if_optional' NOT NULL,
	`salary_amount` real,
	`updated_at` text NOT NULL,
	CONSTRAINT "search_profiles_currency_check" CHECK("currency" IS NULL OR "currency" IN ('VND', 'USD')),
	CONSTRAINT "search_profiles_salary_policy_check" CHECK("salary_policy" IS NULL OR "salary_policy" IN ('blank_if_optional', 'negotiable', 'fixed', 'ask'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_profiles_name_version_uq` ON `search_profiles` (`name`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `search_profiles_single_active_uq` ON `search_profiles` (`active`) WHERE "active" = 1;--> statement-breakpoint
CREATE TABLE `steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`step_key` text NOT NULL,
	`branch_key` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`output_json` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "steps_status_check" CHECK("status" IS NULL OR "status" IN ('pending', 'running', 'waiting', 'done', 'failed', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_key_branch_uq` ON `steps` (`run_id`,`step_key`,`branch_key`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`application_id` integer PRIMARY KEY NOT NULL,
	`final_url` text,
	`fields_json` text NOT NULL,
	`intro_text` text,
	`consent_ticked` integer,
	`consent_text` text,
	`uploaded_filename` text,
	`uploaded_sha256` text,
	`uploaded_path` text,
	`pre_submit_screenshot_path` text,
	`confirmation_screenshot_path` text,
	`confirmation_text` text,
	`approval_token` text,
	`submitted_at` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_token`) REFERENCES `approvals`(`token`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`step_id` integer NOT NULL,
	`bot_name` text NOT NULL,
	`kind` text NOT NULL,
	`input_json` text NOT NULL,
	`output_json` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`pause_reason` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`engine` text NOT NULL,
	`prompt_version` integer,
	`transcript_path` text,
	`uses_browser` integer DEFAULT false NOT NULL,
	`uses_figma` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status_check" CHECK("status" IS NULL OR "status" IN ('queued', 'running', 'waiting_limit', 'paused', 'done', 'failed', 'interrupted')),
	CONSTRAINT "tasks_engine_check" CHECK("engine" IS NULL OR "engine" IN ('claude', 'codex'))
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`,`engine`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_run_idx` ON `tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX `tasks_step_idx` ON `tasks` (`step_id`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`message_id` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `uploads_message_idx` ON `uploads` (`message_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`definition_yaml` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`name`, `version`)
);
