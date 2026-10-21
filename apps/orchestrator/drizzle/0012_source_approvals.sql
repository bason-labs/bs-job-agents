-- API research (design 2026-10-19 §5.1): Ba's approval of a high-risk board's account API, bound to
-- the access record's researchedAt (a re-researched record needs approving again). New table only.
CREATE TABLE `source_approvals` (
	`source` text PRIMARY KEY NOT NULL,
	`approved_at` text NOT NULL,
	`researched_at` text NOT NULL
);
