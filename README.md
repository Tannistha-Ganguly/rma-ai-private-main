# rma-ai

Automated editorial-rules checker for releaseMyAd bookings.

Replaces post-payment manual editorial review with a hybrid rules-engine + LLM judge that catches issues *before* customers submit. Runs in shadow mode alongside the real ops (RO) team, learns from their decisions, and goes customer-facing only after sustained ≥85% alignment over 2 weeks.

## Status

**Phase A complete. 368 rule proposals seeded. Backtest baseline done. Site live.**

| Milestone | Status |
|---|---|
| Schema (`rma_ai`, 5 tables) | ✅ Done |
| Engine (deterministic rules + LLM categorisation + LLM judge) | ✅ Done |
| Backtest harness (~71 RO-flagged historical ads) | ✅ Done — baseline: 0% alignment (0 rules active) |
| Review UI (5 screens) | ✅ Done |
| Deploy → `rma.xpert.chat` | ✅ Live (EC2 + Plesk + PM2) |
| Rule proposals seeded | ✅ 368 proposals from `cat_mes` + `sub_category_tips` |
| Team approves rules | ⏳ Next step |
| Backtest re-run with active rules | ⏳ After approvals |
| Shadow mode (daily run on live ads) | ⏳ Phase B |
| Alignment ≥85% for 2 weeks | ⏳ Gate to customer-facing |

## Live URL

**`https://rma.xpert.chat`** — log in with the shared `ADMIN_PASSWORD`

## Team workflow

For the 2 reviewers — what to do day-to-day:

See **[`docs/team-guide.md`](docs/team-guide.md)** for the full guide.

**TL;DR priority order:**

1. **`/proposals`** first — approve or reject the 368 LLM-drafted rules (takes 1–2 hours total with 2 people)
2. **Rerun the backtest** after approvals to see alignment climb from 0%
3. **`/review`** once backtest runs are loaded — work the "Missed" tab hardest (RO flagged, we didn't)
4. **`/dashboard`** to track alignment heading toward the ≥85% gate

## Local setup

```bash
cp .env.local.example .env.local   # fill in real values
npm install
npm run dev                         # http://localhost:3010
```

For backtest / extraction scripts:

```bash
pip install -r scripts/requirements.txt
set -a; source .env.local; set +a

# Re-seed rule proposals (only needed once, or after a reset):
python3 scripts/extract_starter_rules.py

# Run the backtest after approving proposals:
npm run backtest -- --reset
```

## Deploy

Production is at `https://rma.xpert.chat` on the existing EC2 (`43.204.145.72`), port 3011, PM2.
See [`docs/deploy.md`](docs/deploy.md).

Manual redeploy:
```bash
ssh -i ~/.ssh/xpert_ec2_ads ubuntu@43.204.145.72 \
  'bash /opt/rma-ai/scripts/deploy.sh'
```

## Tech

- Next.js 15 + TypeScript (matches existing Xpert stack)
- MySQL — read-only on `release4_rma`, read/write on `rma_ai`
- Claude Haiku 4.5 for LLM categorisation + semantic judge
- EC2 + Plesk + PM2 at `rma.xpert.chat`

## Phases

| Phase | What | Customer-facing? | Gate |
|---|---|---|---|
| A | Engine + starter rules + backtest on historical ads | No | Team comfortable with rules firing on backtest |
| B | Daily shadow on new ads + alignment with RO team | No | Strict alignment ≥85% sustained 2 weeks |
| C | Block + suggested-fix at booking step 2 | Yes | — |

## Important

- `release4_rma` is **read-only** for this project. All writes go to `rma_ai`.
- Secrets live in `/etc/rma-ai/env` on the server (mode 0600). Never commit secrets.
- Rule proposals are LLM-generated starting points — always human-reviewed before activation.
