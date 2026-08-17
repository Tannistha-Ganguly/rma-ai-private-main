# scripts/

One-off Python utilities for Phase A. The production engine + API live in the Next.js app under `src/` (coming next).

## Setup

```bash
pip install -r scripts/requirements.txt

# In the repo root, copy and fill:
cp .env.local.example .env.local
```

`.env.local` must contain:
- `RMA_HOST`, `RMA_USER`, `RMA_PASS` — read-only `release4_rma` credentials
- `RMA_AI_HOST`, `RMA_AI_USER`, `RMA_AI_PASS` — read/write `rma_ai` credentials (confirmed: `ranita` works for both)
- `ANTHROPIC_API_KEY` — Claude Haiku 4.5 key (rotate from any leaked one first)

To export the env file into your shell session for these scripts:

```bash
set -a; source .env.local; set +a
```

## Scripts

### apply_migration.py

Apply a SQL migration file to `rma_ai`.

```bash
python3 scripts/apply_migration.py sql/migrations/001_initial_schema.sql
```

✅ Already applied 2026-05-18: `editorial_rule`, `editorial_check_run`, `editorial_check_alignment`, `editorial_rule_proposal`, `editorial_check_ack`.

### extract_starter_rules.py

One-shot LLM-assisted extraction of atomic rules from `cat_mes` (148 rows) and `sub_category_tips` (79 rows). Writes proposals to `rma_ai.editorial_rule_proposal` for human approval.

```bash
# Dry run first — see what it would produce, no DB writes:
python3 scripts/extract_starter_rules.py --source cat_mes --limit 3 --dry-run

# Full run (cat_mes + sub_category_tips):
python3 scripts/extract_starter_rules.py
```

Expected output: ~80–150 rule proposals across both source tables. Each proposal is JSON in `editorial_rule_proposal.proposed_payload` with `status='pending'`.

After running, review and approve in the UI (when built) or with SQL:

```sql
-- View all pending proposals
SELECT id, proposed_payload FROM rma_ai.editorial_rule_proposal WHERE status='pending';

-- Approve a single proposal manually (until the UI is built):
-- 1) Copy proposed_payload fields into editorial_rule
-- 2) UPDATE editorial_rule_proposal SET status='approved', decided_by=<your_user_id>, decided_at=NOW(), resulting_rule_id=<new_id> WHERE id=<proposal_id>;
```
