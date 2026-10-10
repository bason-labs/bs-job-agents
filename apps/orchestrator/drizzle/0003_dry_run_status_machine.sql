-- PM phase 1, M3: dry runs and the application status machine.
-- The first three statements are drizzle-kit's (ADD COLUMN and an index re-create: no table
-- rebuild, so the §9.1 triggers on `applications` survive). The trigger changes below are
-- written by hand; drizzle-kit does not track triggers. openDb() checks they exist (M4).
DROP INDEX `applications_job_uq`;--> statement-breakpoint
ALTER TABLE `applications` ADD `dry_run` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `applications_job_uq` ON `applications` (`job_id`) WHERE "reapply" = 0 AND "dry_run" = 0;--> statement-breakpoint
-- Once recorded, only status / status_history_json may change: now also dry_run, created_at and id.
DROP TRIGGER `applications_frozen_after_record`;--> statement-breakpoint
CREATE TRIGGER `applications_frozen_after_record` BEFORE UPDATE ON `applications`
WHEN EXISTS (SELECT 1 FROM `submissions` WHERE `application_id` = OLD.`id`)
  AND (
    NEW.`id` IS NOT OLD.`id`
    OR NEW.`job_id` IS NOT OLD.`job_id`
    OR NEW.`cv_version_id` IS NOT OLD.`cv_version_id`
    OR NEW.`origin` IS NOT OLD.`origin`
    OR NEW.`submitted_at` IS NOT OLD.`submitted_at`
    OR NEW.`reapply` IS NOT OLD.`reapply`
    OR NEW.`dry_run` IS NOT OLD.`dry_run`
    OR NEW.`created_at` IS NOT OLD.`created_at`
  )
BEGIN
	SELECT RAISE(ABORT, 'recorded applications only allow status changes (spec 9.1)');
END;
--> statement-breakpoint
-- Status history is append-only (UC-13): the old history must be a prefix of the new one.
-- The 0001 version only compared lengths, so earlier entries could be rewritten.
DROP TRIGGER `applications_history_append_only`;--> statement-breakpoint
CREATE TRIGGER `applications_history_append_only` BEFORE UPDATE OF `status_history_json` ON `applications`
WHEN json_type(NEW.`status_history_json`) IS NOT 'array'
  OR json_array_length(NEW.`status_history_json`) < json_array_length(OLD.`status_history_json`)
  OR EXISTS (
    SELECT 1 FROM json_each(OLD.`status_history_json`) AS o
    WHERE json_extract(NEW.`status_history_json`, '$[' || o.`key` || ']') IS NOT o.`value`
  )
BEGIN
	SELECT RAISE(ABORT, 'status history is append-only (spec 9.1)');
END;
--> statement-breakpoint
-- A dry run (§12) never reaches `submitted` or any later status, and the flag never changes.
-- The status list is shared POST_SUBMIT_APPLICATION_STATUSES (enums.test.ts checks it).
CREATE TRIGGER `applications_dry_run_update_guard` BEFORE UPDATE ON `applications`
WHEN NEW.`dry_run` IS NOT OLD.`dry_run`
  OR (NEW.`dry_run` = 1 AND NEW.`status` IN ('submitted', 'interviewing', 'offer', 'rejected', 'withdrawn', 'no_response'))
BEGIN
	SELECT RAISE(ABORT, 'a dry run is never submitted and stays a dry run (spec 12)');
END;
--> statement-breakpoint
CREATE TRIGGER `applications_dry_run_insert_guard` BEFORE INSERT ON `applications`
WHEN NEW.`dry_run` = 1 AND NEW.`status` IN ('submitted', 'interviewing', 'offer', 'rejected', 'withdrawn', 'no_response')
BEGIN
	SELECT RAISE(ABORT, 'a dry run is never submitted (spec 12)');
END;
