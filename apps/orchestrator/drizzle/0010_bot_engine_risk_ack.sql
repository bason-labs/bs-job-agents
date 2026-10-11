-- Owner decision 2026-10-11: Ba's opt-in to run CV on Codex without the Figma guard hook
-- (PATCH /bots/:name { engine: "codex", acknowledgeRisk: true }); null = never acknowledged.
-- ADD COLUMN only: no table rebuild, no trigger touched.
ALTER TABLE `bots` ADD `engine_risk_ack_at` text;
