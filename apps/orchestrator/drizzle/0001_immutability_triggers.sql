-- Spec §9.1: the submission record (submissions + job_snapshots) is frozen once
-- written. Only the application's status changes, appended to its history.
CREATE TRIGGER `submissions_no_update` BEFORE UPDATE ON `submissions`
BEGIN
	SELECT RAISE(ABORT, 'submissions are immutable (spec 9.1)');
END;
--> statement-breakpoint
CREATE TRIGGER `submissions_no_delete` BEFORE DELETE ON `submissions`
BEGIN
	SELECT RAISE(ABORT, 'submissions are immutable (spec 9.1)');
END;
--> statement-breakpoint
CREATE TRIGGER `job_snapshots_no_update` BEFORE UPDATE ON `job_snapshots`
BEGIN
	SELECT RAISE(ABORT, 'job_snapshots are immutable (spec 9.1)');
END;
--> statement-breakpoint
CREATE TRIGGER `job_snapshots_no_delete` BEFORE DELETE ON `job_snapshots`
BEGIN
	SELECT RAISE(ABORT, 'job_snapshots are immutable (spec 9.1)');
END;
--> statement-breakpoint
-- An application that has a submission record is never deleted (UC-13).
CREATE TRIGGER `applications_no_delete_recorded` BEFORE DELETE ON `applications`
WHEN EXISTS (SELECT 1 FROM `submissions` WHERE `application_id` = OLD.`id`)
  OR EXISTS (SELECT 1 FROM `job_snapshots` WHERE `application_id` = OLD.`id`)
BEGIN
	SELECT RAISE(ABORT, 'applications with a submission record cannot be deleted (spec 9.1)');
END;
--> statement-breakpoint
-- Once recorded, only status / status_history_json may change on an application.
CREATE TRIGGER `applications_frozen_after_record` BEFORE UPDATE ON `applications`
WHEN EXISTS (SELECT 1 FROM `submissions` WHERE `application_id` = OLD.`id`)
  AND (
    NEW.`job_id` IS NOT OLD.`job_id`
    OR NEW.`cv_version_id` IS NOT OLD.`cv_version_id`
    OR NEW.`origin` IS NOT OLD.`origin`
    OR NEW.`submitted_at` IS NOT OLD.`submitted_at`
    OR NEW.`reapply` IS NOT OLD.`reapply`
  )
BEGIN
	SELECT RAISE(ABORT, 'recorded applications only allow status changes (spec 9.1)');
END;
--> statement-breakpoint
-- Status history is append-only (UC-13).
CREATE TRIGGER `applications_history_append_only` BEFORE UPDATE OF `status_history_json` ON `applications`
WHEN json_array_length(NEW.`status_history_json`) < json_array_length(OLD.`status_history_json`)
BEGIN
	SELECT RAISE(ABORT, 'status history is append-only (spec 9.1)');
END;
--> statement-breakpoint
-- Approval tokens are single-use (UC-08, §10.2 rule 1).
CREATE TRIGGER `approvals_single_use` BEFORE UPDATE OF `used_at` ON `approvals`
WHEN OLD.`used_at` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'approval token already used');
END;
