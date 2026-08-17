-- =============================================================================
-- 002: denormalize source columns on editorial_rule_proposal
-- Lifts source_cat_mes_id + source_table out of proposed_payload JSON so the
-- proposals page can filter by category/newspaper via fast indexed joins.
-- =============================================================================

ALTER TABLE editorial_rule_proposal
  ADD COLUMN source_cat_mes_id INT NULL AFTER source_alignment_id,
  ADD COLUMN source_table      VARCHAR(32) NULL AFTER source_cat_mes_id,
  ADD INDEX idx_source_cat_mes (source_cat_mes_id),
  ADD INDEX idx_source_table (source_table);

-- Backfill from the existing proposed_payload JSON
UPDATE editorial_rule_proposal
SET
  source_cat_mes_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(proposed_payload, '$.source_cat_mes_id')) AS UNSIGNED),
  source_table      = JSON_UNQUOTE(JSON_EXTRACT(proposed_payload, '$.source'))
WHERE proposed_payload IS NOT NULL;

-- JSON_EXTRACT returns the JSON null literal when key missing, which CAST -> 0
-- and JSON_UNQUOTE -> 'null'. Clean those up.
UPDATE editorial_rule_proposal SET source_cat_mes_id = NULL WHERE source_cat_mes_id = 0;
UPDATE editorial_rule_proposal SET source_table = NULL WHERE source_table = 'null';
