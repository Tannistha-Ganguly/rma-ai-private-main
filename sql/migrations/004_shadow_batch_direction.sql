-- =============================================================================
-- 004: shadow_batch.direction — two modes for shadow batches.
--
--   'backward'  — process the N newest unshadowed ads NOW (chunked from UI).
--                 Catches existing ads, possibly already edited by ops.
--   'forward'   — watch for the next N new ads as they arrive after the batch
--                 starts. A worker (scripts/shadow_worker.ts) advances the
--                 batch via PM2 cron every 5 min. Catches ads BEFORE ops can
--                 edit them — the original intent of shadow mode.
--
-- Single-active invariant becomes per-direction at the app layer: one backward
-- and one forward batch may coexist.
-- =============================================================================

ALTER TABLE shadow_batch
  ADD COLUMN direction ENUM('backward', 'forward') NOT NULL DEFAULT 'backward' AFTER target_count,
  ADD INDEX idx_status_direction (status, direction);
