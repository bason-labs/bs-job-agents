-- PM phase 1, M2: an approval token is bound to the one application it authorises.
-- The first two statements are drizzle-kit's (ADD COLUMN: no table rebuild, so
-- `approvals_single_use` is untouched). The rest is written by hand; openDb() checks
-- the triggers exist (M4).
ALTER TABLE `approvals` ADD `application_id` integer REFERENCES applications(id);--> statement-breakpoint
CREATE INDEX `approvals_application_idx` ON `approvals` (`application_id`);--> statement-breakpoint
-- Bind older tokens only where it is provable: the submission record that cites the token.
-- Any other older token stays unbound (NULL) and can no longer start or resume Apply;
-- Ba approves again, which issues a bound token.
UPDATE `approvals`
SET `application_id` = (SELECT s.`application_id` FROM `submissions` AS s WHERE s.`approval_token` = `approvals`.`token` ORDER BY s.`application_id` LIMIT 1)
WHERE `application_id` IS NULL;--> statement-breakpoint
-- An approval is immutable except `used_at` (set once, approvals_single_use) and
-- `allowed_domains_json` (approvals_domains_grow_only), and is never deleted (§10.2 rule 8).
CREATE TRIGGER `approvals_immutable` BEFORE UPDATE ON `approvals`
WHEN NEW.`token` IS NOT OLD.`token`
  OR NEW.`job_id` IS NOT OLD.`job_id`
  OR NEW.`cv_version_id` IS NOT OLD.`cv_version_id`
  OR NEW.`application_id` IS NOT OLD.`application_id`
  OR NEW.`expires_at` IS NOT OLD.`expires_at`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'approvals are immutable except used_at and allowed domains (spec 10.2)');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_no_delete` BEFORE DELETE ON `approvals`
BEGIN
	SELECT RAISE(ABORT, 'approvals are immutable and never deleted (spec 10.2)');
END;
--> statement-breakpoint
-- UC-11 e: Ba may add a domain. The list only grows (the old list is a prefix of the new
-- one), and only until a submission cites the token: the record panel reads this row.
CREATE TRIGGER `approvals_domains_grow_only` BEFORE UPDATE OF `allowed_domains_json` ON `approvals`
WHEN EXISTS (SELECT 1 FROM `submissions` WHERE `approval_token` = OLD.`token`)
  OR json_type(NEW.`allowed_domains_json`) IS NOT 'array'
  OR json_array_length(NEW.`allowed_domains_json`) < json_array_length(OLD.`allowed_domains_json`)
  OR EXISTS (
    SELECT 1 FROM json_each(OLD.`allowed_domains_json`) AS o
    WHERE json_extract(NEW.`allowed_domains_json`, '$[' || o.`key` || ']') IS NOT o.`value`
  )
BEGIN
	SELECT RAISE(ABORT, 'approval domains only grow, and only until a submission cites the token (spec 10.2)');
END;
