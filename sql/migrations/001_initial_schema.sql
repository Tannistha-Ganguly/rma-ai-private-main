-- =============================================================================
-- rma-ai — initial schema for the editorial auto-checker
-- Database: rma_ai
-- Apply with: mysql -h <host> -u <write_user> -p rma_ai < 001_initial_schema.sql
--
-- All tables are NEW. Nothing in release4_rma is touched by this migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) editorial_rule
-- The catalogue of machine-enforceable rules. The team's primary write surface.
-- -----------------------------------------------------------------------------
CREATE TABLE editorial_rule (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  name                 VARCHAR(120) NOT NULL,
  description          TEXT NOT NULL,                    -- internal: what this rule does
  customer_message     TEXT NOT NULL,                    -- shown to the customer when this fires
  rule_type            ENUM(
                          'regex_ban',                   -- text matches pattern → block
                          'must_contain',                -- text must include a pattern
                          'word_count_max',              -- word count <= threshold
                          'word_count_min',              -- word count >= threshold
                          'language_only',               -- text must be in allowed script(s)
                          'format_pattern',              -- must match a structural template
                          'category_match',              -- chosen category must match inferred category
                          'llm_semantic',                -- delegated to LLM judge with rule context
                          'custom_function'              -- engine-defined custom check
                       ) NOT NULL,
  pattern              JSON NOT NULL,                    -- type-specific config
  category_scope       JSON NULL,                        -- array of category_ids (release4_rma.new_categories.category_id); NULL = all categories
  np_scope             JSON NULL,                        -- array of np_ids (release4_rma.newspaper_master.np_id); NULL = all newspapers
  target_ro_reason     INT NULL,                         -- conceptual FK to release4_rma.ro_reason.id (the issue this rule prevents)
  severity             ENUM('hard', 'soft') NOT NULL,
  source               ENUM(
                          'cat_mes_extract',
                          'sub_cat_tips_extract',
                          'team_added',
                          'llm_proposed',
                          'backfilled_from_outcome'
                       ) NOT NULL,
  source_cat_mes_id    INT NULL,                         -- traceability into release4_rma.cat_mes
  status               ENUM('active', 'proposed', 'disabled') NOT NULL DEFAULT 'proposed',
  created_by           INT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           INT NULL,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_target_reason (target_ro_reason),
  INDEX idx_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -----------------------------------------------------------------------------
-- 2) editorial_check_run
-- Every run of the engine. Immutable once written. ad_text snapshot is locked.
-- -----------------------------------------------------------------------------
CREATE TABLE editorial_check_run (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  ad_id                INT NULL,                         -- NULL for compose-time draft / sanity checks
  session_id           VARCHAR(100) NULL,                -- for chained compose-time checks before payment
  run_mode             ENUM('sanity', 'backtest', 'shadow', 'live') NOT NULL,
  ad_text_snapshot     TEXT NOT NULL,                    -- IMMUTABLE — the text we actually evaluated
  ad_text_hash         CHAR(64) NOT NULL,                -- SHA-256 of ad_text_snapshot for cache lookups
  category_chosen      JSON NOT NULL,                    -- {top, sub, sub_sub, sub_sub_sub} as ints
  np_id                INT NULL,
  language_detected    VARCHAR(10) NULL,                 -- ISO 639-1 / IETF tag
  category_suggested   JSON NULL,                        -- from the categorisation pass; NULL if not run
  findings             JSON NOT NULL,                    -- array of {rule_id, severity, message, span?, suggested_rewrite?}
  verdict              ENUM('pass', 'warn', 'block') NOT NULL,
  llm_used             TINYINT(1) NOT NULL DEFAULT 0,
  llm_cost_paise       INT NOT NULL DEFAULT 0,
  latency_ms           INT NULL,
  engine_version       VARCHAR(20) NOT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad (ad_id),
  INDEX idx_mode_date (run_mode, created_at),
  INDEX idx_hash (ad_text_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -----------------------------------------------------------------------------
-- 3) editorial_check_alignment
-- The team's review surface. Computed by a daily cron, only for eligible ads
-- (ad_master.status = 5 OR ad_master.earliest_publish_date < CURDATE()).
-- -----------------------------------------------------------------------------
CREATE TABLE editorial_check_alignment (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  check_run_id         INT NOT NULL,                     -- FK editorial_check_run.id
  ad_id                INT NOT NULL,

  -- The raw inputs
  our_rule_ids         JSON NOT NULL,                    -- array of editorial_rule.id we fired
  ro_reason_ids        JSON NOT NULL,                    -- array of release4_rma.ro_reason.id RO fired

  -- Derived for fast filtering and clear UI display
  flag_overlap         JSON NOT NULL,                    -- (our ∩ ro) — flags both sides agreed on
  we_extra             JSON NOT NULL,                    -- flags only we have
  ro_extra             JSON NOT NULL,                    -- flags only RO has

  outcome              ENUM(
                          'FULL_MATCH',                  -- our_flags == ro_flags (set equality)
                          'PARTIAL_OVERLAP',             -- some overlap, each side has extras
                          'NO_OVERLAP_BOTH_FLAGGED',     -- both flagged, zero overlap
                          'WE_ONLY',                     -- we flagged, RO did not
                          'RO_ONLY',                     -- RO flagged, we did not
                          'BOTH_CLEAN',                  -- neither flagged
                          'PENDING_RO_REVIEW',           -- ad not yet eligible (RO window still open)
                          'DATA_QUALITY'                 -- skip in aggregate (mis-tagged note etc.)
                       ) NOT NULL,
  eligible_at          DATETIME NULL,                    -- when this ad became evaluable

  -- Team's review decisions
  reviewed_by          INT NULL,
  review_decision      ENUM(
                          'rule_correct',
                          'rule_too_strict',
                          'rule_too_lax',
                          'new_rule_needed',
                          'rule_needs_refinement',
                          'data_quality_issue',
                          'ignored'
                       ) NULL,
  resulting_rule_id    INT NULL,                         -- FK editorial_rule.id if a new rule was created
  resulting_action     TEXT NULL,                        -- short reviewer note
  computed_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at          DATETIME NULL,

  INDEX idx_outcome_date (outcome, computed_at),
  INDEX idx_unreviewed (reviewed_by, computed_at),
  INDEX idx_check_run (check_run_id),
  INDEX idx_ad (ad_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -----------------------------------------------------------------------------
-- 4) editorial_rule_proposal
-- Drafts awaiting team approval. Becomes editorial_rule on approval.
-- -----------------------------------------------------------------------------
CREATE TABLE editorial_rule_proposal (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  proposed_by          VARCHAR(40) NOT NULL,             -- admin user id or 'llm'
  source_alignment_id  INT NULL,                         -- FK editorial_check_alignment.id, if proposed from an alignment row
  proposed_payload     JSON NOT NULL,                    -- the would-be editorial_rule fields
  status               ENUM('pending', 'approved', 'rejected', 'superseded') NOT NULL DEFAULT 'pending',
  decided_by           INT NULL,
  decided_at           DATETIME NULL,
  resulting_rule_id    INT NULL,                         -- FK editorial_rule.id if approved
  notes                TEXT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_source_alignment (source_alignment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -----------------------------------------------------------------------------
-- 5) editorial_check_ack
-- Customer-side acknowledgements. Only used in run_mode = 'live' (Phase C).
-- Tracks soft-warn acceptances and "accepted suggested fix" events.
-- -----------------------------------------------------------------------------
CREATE TABLE editorial_check_ack (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  check_run_id         INT NOT NULL,                     -- FK editorial_check_run.id
  rule_id              INT NULL,                         -- which rule was acknowledged (NULL if generic fix-accept)
  ack_type             ENUM('soft_warn_accepted', 'suggested_fix_accepted', 'manual_edit') NOT NULL,
  acknowledged_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_check_run (check_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
