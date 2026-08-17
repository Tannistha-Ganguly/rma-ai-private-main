-- =============================================================================
-- 003: shadow_batch — controlled, phased shadow-mode runs.
--
-- The team starts a batch ("next 100 new ads"), and the shadow_worker cron
-- runs the engine on each new ad_master row created after the batch started,
-- up to target_count, then stops. New batches must be started explicitly so
-- LLM cost is bounded and reviewers can keep pace.
--
-- Single-active invariant is enforced at the app layer (server action checks
-- for an existing 'active' row before inserting).
-- =============================================================================

CREATE TABLE shadow_batch (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  target_count         INT NOT NULL,
  processed_count      INT NOT NULL DEFAULT 0,
  -- High-water mark at the moment the batch started; we only process ads
  -- strictly newer than this. NULL is not allowed: a batch with no anchor
  -- would consume the entire ad_master table.
  start_ad_id          INT NOT NULL,
  -- Updated as the worker advances; NULL until the first ad in the batch
  -- has been processed.
  last_processed_ad_id INT NULL,
  status               ENUM('active', 'completed', 'cancelled') NOT NULL DEFAULT 'active',
  started_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at         DATETIME NULL,
  -- Optional admin user id (admin auth in this project is a shared password,
  -- so this column may always be NULL until per-user auth lands).
  started_by           INT NULL,
  INDEX idx_status (status),
  INDEX idx_started_at (started_at)
);
