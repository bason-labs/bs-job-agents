-- PM phase 1, M1: a submission record always matches its approval (§9.1, §10.2 rule 1).
-- recordSubmission refuses a mismatched record first, with a typed error (token and file);
-- these triggers make the token and dry-run part impossible in SQL as well. No table changes
-- (drizzle-kit generate --custom); openDb() checks the triggers exist (M4).
--
-- Trigger bodies here reference only `applications` and `approvals`, which are never rebuilt:
-- SQLite >= 3.26 re-checks every trigger on ALTER TABLE ... RENAME, so a trigger that names a
-- table makes a rebuild of that table fail. The SHA-256 check therefore stays in the
-- repository rather than reaching into `cv_versions`.
--
-- An app-made record (imported ones are partial by design, UC-13) cites a token that Apply's
-- first spawn consumed and that was issued for this application, job and CV version, and
-- its dry-run flag is the application's.
CREATE TRIGGER `submissions_match_approval` BEFORE INSERT ON `submissions`
WHEN (SELECT `origin` FROM `applications` WHERE `id` = NEW.`application_id`) = 'app'
  AND (
    NEW.`dry_run` IS NOT (SELECT `dry_run` FROM `applications` WHERE `id` = NEW.`application_id`)
    OR NOT EXISTS (
      SELECT 1 FROM `approvals` AS a JOIN `applications` AS p ON p.`id` = NEW.`application_id`
      WHERE a.`token` = NEW.`approval_token`
        AND a.`used_at` IS NOT NULL
        AND a.`application_id` = p.`id`
        AND a.`job_id` = p.`job_id`
        AND a.`cv_version_id` = p.`cv_version_id`
    )
  )
BEGIN
	SELECT RAISE(ABORT, 'the submission record does not match its approval (spec 9.1, 10.2)');
END;
--> statement-breakpoint
-- The approved file is the CV version's PDF when the token was issued: once a token names a
-- CV version, its PDF path and SHA-256 never change (a re-export is a new CV version), so
-- recordSubmission's SHA-256 check always compares against the file Ba approved.
CREATE TRIGGER `cv_versions_pdf_frozen_once_approved` BEFORE UPDATE OF `pdf_path`, `pdf_sha256` ON `cv_versions`
WHEN EXISTS (SELECT 1 FROM `approvals` WHERE `cv_version_id` = OLD.`id`)
  AND (NEW.`pdf_path` IS NOT OLD.`pdf_path` OR NEW.`pdf_sha256` IS NOT OLD.`pdf_sha256`)
BEGIN
	SELECT RAISE(ABORT, 'an approved CV version keeps its PDF (spec 9.1)');
END;
