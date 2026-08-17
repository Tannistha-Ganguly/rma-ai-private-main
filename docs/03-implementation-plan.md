# Implementation Plan — RMA Editorial Auto-Checker

_Draft 2026-05-18. Built on the company overview and EDA findings (docs 01 + 02). Sharad to review before any code lands._

---

## Goal

Catch the editorial issues that ops currently catches **after** payment (causing customer rework and ops overhead) **before** the customer hits "pay", by automatically checking the ad text against the same rules ops applies today. Measured by: (a) recall against historical ops-flagged tickets, (b) precision (false-positive rate, since wrong blocks hurt UX more than missed blocks).

## Architecture (Option C — hybrid)

```
                      ┌────────────────────────────┐
   Ad text (any lang) │  Pass 1: Rules Engine      │ deterministic, ~ms latency
   + category_id ──── │  - structured rule rows    │
   + np_id            │  - regex / pattern / count │
   + ad_type          │  - language-aware tokenize │
                      └────────────┬───────────────┘
                                   │ verdict + reasons
                                   ▼
                      ┌────────────────────────────┐
                      │  Pass 2: LLM Judge          │ only if Pass 1 = pass OR ambiguous
                      │  - relevant cat_mes prose   │
                      │  - relevant sub_cat_tips    │ as system context
                      │  - rules engine output      │
                      └────────────┬───────────────┘
                                   │
                                   ▼
                      ┌────────────────────────────┐
                      │  Verdict response           │
                      │  {                          │
                      │    decision: pass|warn|block│
                      │    findings: [{rule_id,     │
                      │      severity,              │
                      │      message_to_customer,   │
                      │      span?                  │
                      │    }]                       │
                      │  }                          │
                      └─────────────────────────────┘
```

## Stack

- **Service:** Next.js API route (`/api/editorial/check`) on the existing EC2 + Plesk + PM2 setup. Mirrors the deployment shape Sharad already uses for Xpert. No new infra.
- **DB:** new MySQL tables in `release4_rma` (or a separate `release4_rma_editorial` schema to keep blast radius small — Sharad's call).
- **LLM:** Claude Haiku 4.5 for pass 2 (cheap, fast, multilingual). Cached by `(ad_text_hash, category_id, np_id)` so re-checks during a session don't re-bill.
- **Backtest harness:** Python script that reads from `forum_report_email_master` + `forum_report_email` + `ad_master`, runs the engine, writes results to a `backtest_runs` table. Same script powers the daily shadow-mode run in Phase 2.
- **Review UI:** Next.js page under the existing RMA admin panel, behind admin login. No customer-facing exposure until Phase 3.

## New database tables (proposed)

```sql
-- One row per atomic, machine-checkable rule
CREATE TABLE editorial_rule (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(120) NOT NULL,
  description     TEXT NOT NULL,                -- shown to customer when fired
  category_id     INT NULL,                     -- NULL = applies to all categories
  np_ids_csv      TEXT NULL,                    -- CSV of np_id; NULL = all newspapers
  rule_type       ENUM('regex_ban','must_contain','word_count_max',
                       'word_count_min','language_only','format_pattern',
                       'category_match','custom_function') NOT NULL,
  pattern         TEXT NULL,                    -- regex / json config per rule_type
  severity        ENUM('hard','soft') NOT NULL, -- hard = block; soft = warn+ack
  source_cat_mes_id INT NULL,                   -- traceability to the originating row
  source_sub_cat_tips_id INT NULL,
  source_ro_reason  INT NULL,                   -- the ro_reason this rule prevents
  active          TINYINT DEFAULT 1,
  created_by      INT NULL,
  created_at      DATETIME,
  updated_at      DATETIME
);
CREATE INDEX idx_editorial_rule_lookup ON editorial_rule (category_id, active);

-- Every check run (shadow or live), one row per ad evaluation
CREATE TABLE editorial_check_run (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  ad_id           INT NULL,                     -- null until ad is created (compose-time)
  session_id      VARCHAR(100) NULL,            -- to chain compose-time checks
  category_id     INT NULL,
  np_id           INT NULL,
  ad_text_hash    CHAR(64) NOT NULL,            -- sha256 of ad_text for cache
  ad_text_excerpt TEXT NULL,                    -- first 500 chars for review UI
  language        VARCHAR(10) NULL,             -- detected language code
  pass1_findings  JSON NULL,                    -- rules engine output
  pass2_findings  JSON NULL,                    -- LLM output (if invoked)
  final_verdict   ENUM('pass','warn','block') NOT NULL,
  mode            ENUM('backtest','shadow','live') NOT NULL,
  llm_used        TINYINT DEFAULT 0,
  llm_cost_paise  INT DEFAULT 0,                -- track LLM spend
  latency_ms      INT NULL,
  created_at      DATETIME
);
CREATE INDEX idx_check_run_ad ON editorial_check_run (ad_id);
CREATE INDEX idx_check_run_mode_date ON editorial_check_run (mode, created_at);
```

`editorial_rule` is the only "writable" table from the admin UI — the team adds/edits/disables rules as they learn from the review UI.

## Phase 0 — Foundation (Week 1)

1. **Compute the precise editorial-issue rate** with a clean query (use `ad_master.adtime` timestamp, not `creation_date` varchar). Publish in a metrics dashboard or just shared sheet. This becomes our baseline.
2. **Pull the backtest dataset**: last 2,000 ads where `forum_report_email_master.reason ∈ editorial-codes`, joined with `ad_master.ad_text` and a representative ops note from `forum_report_email`. Store as a CSV / JSON file in the repo for reproducible runs.
3. **Pull the negative-control dataset**: 2,000 ads with **no** editorial ticket from the same time window, matched on category distribution. We need both classes to measure precision.
4. **Seed the rule catalogue**: one-time LLM-assisted pass over `cat_mes` (148 rows) and `sub_category_tips` (79 rows), with Sharad/team in the loop to approve each extracted rule. Target: 60–100 atomic rules across the 12 editorial reason buckets.

   Concretely: I'll generate `proposed_rules.csv` from the LLM, you/the team accepts/edits/rejects each row, then we insert the approved ones into `editorial_rule`.

## Phase 1 — Engine + backtest (Week 2)

5. **Rules engine implementation.** A Next.js API route + a pure TS module so it can also be called from the backtest harness without HTTP overhead.
6. **LLM judge implementation.** Prompt template that takes ad text + category + relevant `cat_mes` messages + the rules engine output, returns structured findings. Haiku 4.5, with prompt caching on the static parts (system prompt + rule list per category).
7. **Backtest harness** runs the engine over the 2,000-ad dataset + the 2,000-control dataset. Reports:
   - **Recall** per editorial reason bucket — what % of historical tickets we'd have flagged
   - **Precision** — of our flags, what % had a matching ops ticket (or our team agrees in review they should have)
   - **Confusion examples** — false positives (we flagged, ops didn't) + false negatives (ops flagged, we missed), saved with full context for the team to read
8. **Iterate on rules** based on backtest output until we hit a target (suggest: ≥60% recall, ≥80% precision on the broad editorial-reason set, before going to Phase 2).

## Phase 2 — Internal review UI + shadow mode (Week 3)

9. **Daily shadow run** — a cron job on EC2 that runs the engine over every new ad created in the past 24 hours and writes to `editorial_check_run` with `mode='shadow'`. Zero customer-facing impact.
10. **Review UI** under the existing RMA admin panel. Single page:
    - Filter: date range, category, verdict, language
    - List view: ad_text, our verdict, our findings, **actual ops outcome** (joined from `forum_report_email_master`)
    - Per-row actions: "agreed — our flag was correct", "false positive — disable this rule for this case", "missed — add a new rule for this", "rule needs edit — open editor"
    - Inline rule editor that updates `editorial_rule`
11. **Team validation period** — 2–4 weeks of daily review. Sharad / ops lead reviews 20–50 ads/day. Rules get tuned. We track recall/precision week over week.
12. **Decision gate** — when the team is confident (define quantitative bar with Sharad), we proceed to Phase 3. Until then, no customer-facing change.

## Phase 3 — Customer-facing deployment

13. **Step 2 of booking flow** — server-side check on submit. Hard-block + soft-warn UX:
    - Hard-block: customer cannot proceed; sees rule message + which sentence is problematic (if span-level info exists). Has option to "request manual review" which routes to ops as today (safety valve).
    - Soft-warn: customer sees a warning, can acknowledge and proceed. We record the ack so ops sees it was warned-and-accepted.
14. **Live checks logged** with `mode='live'`. Continue to compare against actual ops outcomes — i.e., for any ad we let through that subsequently gets an ops ticket, that's a false negative we should learn from.
15. **Mobile app integration** — same API; mobile UI calls the same `/api/editorial/check` endpoint at step 2.
16. **Eventual inline check at compose time** — once the at-submit gate is stable, layer a real-time check (like spell-check) on top of the same engine. Future iteration, not v1.

## What I'm explicitly de-scoping from v1

- `sub_category_tips`-based subcategory inference (Sharad's Phase-2)
- Display-ad design checks (`cd_*_text` fields, image-based) — fundamentally different problem
- Document-upload validation (separate ops workflow)
- Customer-facing inline / real-time check (post-MVP)
- Per-rule a/b testing UI
- Multi-tenant rule scoping (e.g., per-RMA-agent rule overrides)

## What I still need from you to start

1. **Approve the 12 editorial reason codes** as the target set (`1, 2, 4, 10, 11, 12, 13, 18, 109, 137, 150, 207`), or amend.
2. **Confirm the new tables can live in `release4_rma`** vs a separate schema.
3. **A name + commit on UX for the hard-block** — minimum viable: "your ad has issues, fix to proceed" with rule message. Span-highlighting is nicer but adds work. v1 with or without?
4. **Approve the Haiku-4.5 LLM choice** for Pass 2 (cheap, multilingual, ~$0.8/M input + $4/M output → roughly ₹0.05–0.10 per check at realistic prompt sizes). Or push to a different model.
5. **Where do I start coding?** Two reasonable starts:
   - (a) Phase-0 backtest dataset extraction first — get the numbers honest, get the team excited.
   - (b) Phase-0 + Phase-1 rule extraction first — get a tangible artifact (the `proposed_rules.csv`) for the team to react to.

   My recommendation is (a) then (b) in the same week — they unblock each other.

---

# Plan revision (2026-05-18, after Sharad's refinements)

Four refinements from Sharad reshape the plan. They all point the same direction: **the product is the shadow-mode alignment loop, not a one-shot backtest.** Customer-facing deployment is the final step that we only take when alignment with the RO team is high enough.

## Refinement 1 — Categorization is a first-class check, in v1

Engine input expands from "ad text" to **"ad text + customer's chosen categorization tuple"** (top-cat + sub + sub-sub + sub-sub-sub).

The engine's output now always includes a categorization verdict:
- Does the chosen categorization match what the ad text describes?
- If not, what categorization should the customer have chosen?

This maps to `ro_reason` codes 4 (Incorrect Categorization) and 150 (Category Missing) — both already in our editorial-12 set. So the work was implicitly in scope, but we'll surface it as its own pass with its own output structure.

Implementation: a category-classifier pass that uses the ad text + (optionally) the customer's chosen subcategory as input. Likely an LLM call against the full `new_categories` taxonomy (17.7k rows, filtered to active + relevant ad-type) — too many categories for pure deterministic rules. This is the one place where the LLM is in the hot path from day one.

## Refinement 2 — Historical backtest is partially feasible (revised after `ad_master_update` finding)

**First pass (now superseded):** I'd written off the historical backtest because `ad_master.ad_text` is rewritten in place. Verified empirically — 314 of 527 editorial-flagged ads with a preview row (60%) have their current `ad_master.ad_text` differing from the preview snapshot.

**Revised, after Sharad pointed to `ad_master_update`:** that table preserves the pre-edit ad text. It has 3,200 rows / 1,834 distinct ads spanning Jan 2017 – May 2026, and **1,528 of those 1,834 ads (83%) also have an editorial ticket in `forum_report_email_master`** — so this is effectively the "ops edited the text for editorial reasons" log.

Confirmed on real cases: ads `1940427`, `1938410`, `1940492` all show Indian-language mojibake (`???` runs from broken Unicode submission) in `ad_master_update.ad_text`, and clean Malayalam / Tamil / Devanagari in current `ad_master.ad_text`. Ops notes on those tickets explicitly mention encoding issues. Perfect ground-truth for reason 18 ("Unidentified characters in the ad text") and reasons 10 / 11 ("Edit Ad Matter" / "Newspaper does not accept").

**Implication:** a real backtest is feasible on the ~1,528-ad subset where original text is recoverable. That's ~75% of the 2,000-sample size you asked for. It's biased toward text-content reasons (1, 2, 11, 12, 13, 18, 137), which is exactly what the rules engine most needs to validate. For non-text reasons (4 Incorrect Categorization, 150 Category Missing, 109 Spam) the text doesn't change much, so the current `ad_master.ad_text` is a fine proxy.

**Two-tier validation methodology:**

| Tier | Source of truth | Sample | Role |
|---|---|---|---|
| Backtest (Phase A) | `ad_master_update`-recovered original text + matched `forum_report_email_master` tickets | ~1,528 ads, text-content reasons | Fast sanity gate — does the engine produce sensible findings? Days, not weeks |
| Shadow + RO alignment (Phase B onwards) | Live new ads + RO team's live decisions | All new ads, daily | **Gates customer-facing rollout.** Robust to recent distribution shifts and rule changes |

Backtest is no longer the rollout gate — but it's a real Phase A milestone, not just a "does it crash" check.

## Refinement 3 — Shadow-mode-with-RO-team-alignment IS the product

The current scope rewritten as 3 phases:

### Phase A: Build engine + seed rules + backtest (week 1)

- Engine implementation: rules pass + categorization pass + LLM judge pass
- One-time LLM-assisted extraction of starter rules from `cat_mes` (148) + `sub_category_tips` (79), reviewed and approved by team into `editorial_rule`
- **Real backtest on ~1,528 ads** with `ad_master_update`-recovered original text, joined to `forum_report_email_master` tickets. Report per-rule and per-reason recall + precision. Iterate on rules until baseline is acceptable
- Review UI v0 (read-only): shows engine output for any ad_id, plus the backtest results browser (filter by outcome, see ad text + our findings + ops note side-by-side)

### Phase B: Shadow + alignment loop (week 2 onwards, runs continuously)

This is the product for a while.

- **Daily cron**: every new ad in the past 24h is fed to the engine. Verdict + findings written to `editorial_check_run`. Pure shadow — no customer impact.
- **Eligibility gate for alignment evaluation (added 2026-05-18 per Sharad).** An ad is only eligible for alignment computation once RO's review window has closed. Predicate:

  ```sql
  WHERE ad_master.status = 5                      -- "Confirmed for Release" (RO has cleared)
     OR ad_master.earliest_publish_date < CURDATE() -- first release date has passed
  ```

  Ads not yet eligible — typically those booked for future publication where RO hasn't reached the processing stage — get marked `PENDING_RO_REVIEW` and re-checked daily until eligible. This prevents false-attributing "RO didn't flag this" when RO simply hadn't reviewed yet.

- **Daily alignment job**: runs over all eligible shadow-run rows. Compares our findings against `forum_report_email_master` tickets on the same ad. Writes to `editorial_check_alignment` with one of 7 outcomes (+ pending + data-quality):

  | Outcome | Meaning | Team action in review UI |
  |---|---|---|
  | `FULL_MATCH` | `our_flags == ro_flags` (set equality) | Confirm rule is working ✅ |
  | `PARTIAL_OVERLAP` | Both flagged; some overlap; each side has at least one unique flag | Both: investigate our extras (too strict?) AND add rule for what RO caught |
  | `NO_OVERLAP_BOTH_FLAGGED` | Both flagged, **zero overlap** in what each side saw | Two corrections in one row — most valuable learning bucket |
  | `WE_ONLY` | We flagged, RO did not | Rule too strict, or RO missed. Disambiguate |
  | `RO_ONLY` | RO flagged, we did not | New rule opportunity — LLM drafts a starter |
  | `BOTH_CLEAN` | Neither flagged | Implicit true negative; spot-check sample |
  | `PENDING_RO_REVIEW` | Eligibility gate not met yet | Skip; re-check tomorrow |
  | `DATA_QUALITY` | Note was customer-reply mis-tagged, or other noise | Flag and ignore in aggregate metrics |

- **Review UI** under existing admin panel:
  - Default landing: yesterday's runs grouped by outcome bucket
  - Per-row context: ad text, our findings, RO's findings, the rule each fired against
  - Per-row actions (one click each):
    - "We were right" → log confirmation, no rule change
    - "Rule too strict" → opens rule edit / disable / scope-narrow dialog
    - "Missed — need new rule" → opens new-rule proposal form (LLM pre-fills a starter from the ad + RO note)
    - "Different issue than ours" → opens rule split/refine
    - "Data quality / ignore" → flag and skip

- **Aggregate metric** = alignment rate = `(MATCH + BOTH_CLEAN) / (total non-data-quality rows)`. Tracked weekly.

### Phase C: Customer-facing deployment (when alignment ≥ Sharad's target)

- Once the alignment metric is above an agreed threshold (e.g. 85%, to be agreed) for an agreed window (e.g. 2 consecutive weeks), gradually flip on the customer-facing block:
  - Start with hard-block disabled (warn-only) for a week — soft launch
  - Then enable hard-block for a single category (e.g. Change of Name where rules are clearest) — narrow launch
  - Then expand category by category as confidence holds
- Booking step 2 + future redesign + mobile — same API endpoint

**Propose-the-fix UX (new requirement from Sharad, 2026-05-18):** when a hard-block fires, the customer-facing response includes a **rewritten version of the ad text** that satisfies the violated rule(s). The LLM judge already has the ad text and the rule context, so a second LLM call (or the same call, with output schema extended) produces the corrected text. The customer sees the issue, the proposed fix, and a one-click "Accept fix" button alongside "Edit manually". Manual edit remains the escape hatch.

Engineering implications to design in from Phase A:
- The LLM judge response schema needs a `suggested_rewrite` field (nullable for soft warnings, populated for hard blocks)
- The `editorial_check_run.findings` JSON gains a `suggested_rewrite` field per finding (or one consolidated rewrite covering all hard-block findings)
- A new `editorial_check_ack` row type for "customer accepted suggested fix" (so we can measure accept-rate as a UX quality signal)
- If the customer accepts, the new ad_text is saved as the canonical version; the original goes into `editorial_check_run.ad_text_snapshot` (already designed-in)

## Refinement 4 — Where rules live, who updates them, how the loop closes

`cat_mes` stays in `release4_rma` untouched. We don't touch the existing customer-facing advisory messages at booking time. That workflow continues as-is.

**Our new tables live in `rma_ai` (the new DB).** The team's primary surface for adding/editing/disabling rules is the review UI, which writes to `rma_ai.editorial_rule`.

### Table structure (all in `rma_ai`)

```sql
-- 1) THE RULE CATALOGUE — what the engine enforces. The team's primary write surface.
CREATE TABLE editorial_rule (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(120) NOT NULL,            -- e.g. "Obituary must not mention cause of death"
  description       TEXT NOT NULL,                    -- human description (for the review UI)
  customer_message  TEXT NOT NULL,                    -- what the customer sees when this fires
  rule_type         ENUM('regex_ban','must_contain','word_count_max','word_count_min',
                         'language_only','format_pattern','category_match',
                         'llm_semantic','custom_function') NOT NULL,
  pattern           JSON NOT NULL,                    -- type-specific config
  category_scope    JSON NULL,                        -- array of category_ids; NULL = all
  np_scope          JSON NULL,                        -- array of np_ids; NULL = all
  target_ro_reason  INT NULL,                         -- which ro_reason.id this addresses (FK conceptually)
  severity          ENUM('hard','soft') NOT NULL,
  source            ENUM('cat_mes_extract','sub_cat_tips_extract','team_added',
                         'llm_proposed','backfilled_from_outcome') NOT NULL,
  source_cat_mes_id INT NULL,                         -- traceability into release4_rma.cat_mes
  status            ENUM('active','proposed','disabled') NOT NULL DEFAULT 'proposed',
  created_by        INT NULL,
  created_at        DATETIME NOT NULL,
  updated_by        INT NULL,
  updated_at        DATETIME NULL,
  INDEX idx_active_cat (status, category_scope(64))
);

-- 2) EVERY CHECK RUN. Immutable. ad_text snapshot is locked at write time.
CREATE TABLE editorial_check_run (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  ad_id               INT NULL,                       -- null for compose-time draft checks
  session_id          VARCHAR(100) NULL,
  run_mode            ENUM('sanity','shadow','live') NOT NULL,
  ad_text_snapshot    TEXT NOT NULL,                  -- IMMUTABLE — the text we actually saw
  ad_text_hash        CHAR(64) NOT NULL,
  category_chosen     JSON NOT NULL,                  -- {top, sub, sub_sub, sub_sub_sub}
  np_id               INT NULL,
  language_detected   VARCHAR(10) NULL,
  category_suggested  JSON NULL,                      -- from the categorization pass
  findings            JSON NOT NULL,                  -- array of {rule_id, severity, message, span?}
  verdict             ENUM('pass','warn','block') NOT NULL,
  llm_used            TINYINT DEFAULT 0,
  llm_cost_paise      INT DEFAULT 0,
  latency_ms          INT NULL,
  engine_version      VARCHAR(20) NOT NULL,
  created_at          DATETIME NOT NULL,
  INDEX idx_ad (ad_id),
  INDEX idx_mode_date (run_mode, created_at)
);

-- 3) ALIGNMENT WITH RO TEAM. Computed by cron 2 days after the check run. The team's review surface.
CREATE TABLE editorial_check_alignment (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  check_run_id        INT NOT NULL,                   -- FK editorial_check_run.id
  ad_id               INT NOT NULL,
  our_rule_ids        JSON NOT NULL,                  -- array of editorial_rule.id we fired
  ro_reason_ids       JSON NOT NULL,                  -- array of ro_reason.id from forum_report_email_master
  flag_overlap        JSON NOT NULL,                  -- intersection (derived for fast filter)
  we_extra            JSON NOT NULL,                  -- our flags not present on RO side
  ro_extra            JSON NOT NULL,                  -- RO flags not present on our side
  outcome             ENUM('FULL_MATCH','PARTIAL_OVERLAP','NO_OVERLAP_BOTH_FLAGGED',
                            'WE_ONLY','RO_ONLY','BOTH_CLEAN',
                            'PENDING_RO_REVIEW','DATA_QUALITY') NOT NULL,
  eligible_at         DATETIME NULL,                  -- when this ad became evaluable (status=5 or pub date passed)
  reviewed_by         INT NULL,                       -- admin user id
  review_decision     ENUM('rule_correct','rule_too_strict','rule_too_lax',
                            'new_rule_needed','rule_needs_refinement','data_quality_issue','ignored') NULL,
  resulting_rule_id   INT NULL,                       -- if a new rule was created
  resulting_action    TEXT NULL,                      -- short note from the reviewer
  computed_at         DATETIME NOT NULL,
  reviewed_at         DATETIME NULL,
  INDEX idx_outcome (outcome, computed_at),
  INDEX idx_unreviewed (reviewed_by, computed_at)
);

-- 4) PROPOSED RULES from LLM or team, awaiting approval. Becomes editorial_rule on approval.
CREATE TABLE editorial_rule_proposal (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  proposed_by         VARCHAR(40) NOT NULL,           -- admin id or 'llm'
  source_alignment_id INT NULL,                       -- FK editorial_check_alignment.id (if proposed from an alignment row)
  proposed_payload    JSON NOT NULL,                  -- the would-be editorial_rule fields
  status              ENUM('pending','approved','rejected','superseded') NOT NULL DEFAULT 'pending',
  decided_by          INT NULL,
  decided_at          DATETIME NULL,
  resulting_rule_id   INT NULL,                       -- FK editorial_rule.id if approved
  created_at          DATETIME NOT NULL
);

-- 5) (Phase C) Customer-side acknowledgement of soft warnings. Only used in 'live' mode.
CREATE TABLE editorial_check_ack (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  check_run_id        INT NOT NULL,
  rule_id             INT NOT NULL,
  acknowledged_at     DATETIME NOT NULL
);
```

### How the team uses this day-to-day

Picture the daily review UI as one page with five tabs, each backed by a `WHERE outcome = ...` filter on `editorial_check_alignment`:

| Tab | Outcome | What the team does |
|---|---|---|
| **Confirms** | FULL_MATCH + BOTH_CLEAN (sampled) | Spot-check; no action by default. Quick scroll for confidence. |
| **False positives?** | WE_ONLY | Read each one. Click "rule too strict" → narrows scope / disables / refines; "RO missed it" → flag for RO QA |
| **Missed** | RO_ONLY | High-value bucket. Click "needs new rule" → LLM-prefilled draft of an `editorial_rule_proposal` → team edits → approves → lands in `editorial_rule` (active) |
| **Partial agreement** | PARTIAL_OVERLAP | Both flagged correctly on the overlap; each side has extras. Investigate our extras (too strict?) AND consider rules for RO's extras |
| **Different things flagged** | NO_OVERLAP_BOTH_FLAGGED | Highest-value learning bucket: review our flag (probably wrong) AND add a rule for RO's flag — two corrections per row |
| **Pending RO review** | PENDING_RO_REVIEW | Visible but not actionable; eligibility re-checked daily as status changes / publish dates pass |
| **Data quality** | DATA_QUALITY | Mark and ignore — excluded from aggregate metrics |

### Aggregate alignment metric

The gating metric for Phase C rollout, computed over a rolling 2-week window of eligible rows:

```
strict_alignment_rate  =  (FULL_MATCH + BOTH_CLEAN)
                          / (eligible_total - PENDING_RO_REVIEW - DATA_QUALITY)

partial_credit_rate    =  strict_alignment_rate
                          + 0.5 * PARTIAL_OVERLAP
                            / (eligible_total - PENDING_RO_REVIEW - DATA_QUALITY)
```

Strict rate is what gates rollout. Partial-credit rate is the secondary signal that lets us see *progress* during the iteration phase even before strict rate hits target.

`cat_mes` is **never edited from the team's side for the auto-checker**. It continues to serve its existing customer-facing advisory purpose. If we extract a new rule from a `cat_mes` row, the rule lands in `editorial_rule` with `source='cat_mes_extract'` and `source_cat_mes_id` pointing back. If a customer-facing advisory message *also* needs to be updated, that's a separate action handled by whoever currently owns `cat_mes` editing.

### How rules learn over time

The loop is:
1. Engine runs over today's ads → writes to `editorial_check_run`
2. Two days later, cron joins against `forum_report_email_master` → writes to `editorial_check_alignment`
3. Team reviews the non-MATCH buckets → writes back review decisions + creates rules
4. New rules immediately take effect on tomorrow's ads
5. Aggregate alignment % is plotted weekly
6. When it crosses Sharad's target threshold for the agreed window → Phase C flips on customer-facing

The system becomes self-improving in the sense that every disagreement between us and ops produces either (a) a tightened rule, (b) a new rule, or (c) a documented "we agree to disagree" entry. Stable equilibrium = high alignment %.

## What I'm asking you to confirm

1. **Use the visible `rma_ai` database** for all new tables — yes?
2. **The 5-table structure above** — does it match how you imagine the team using it? Anything missing or that you'd cut?
3. **Two-tier validation** confirmed: real backtest on ~1,528 ads (`ad_master_update`-recovered original text) as a Phase A milestone, then shadow + RO alignment as the rollout gate. Backtest itself is not the rollout gate. Agree?
4. **Alignment-% threshold for Phase C** — what number gives you confidence? I'd default to **≥85% sustained for 2 weeks** but you have the better intuition.
5. **Start order in week 1:** seed rules + engine skeleton + shadow harness, in that order. I'll send a more granular day-by-day breakdown once you sign off on the above.

