# Review UI — Wireframes (ASCII, v0)

The team's daily work surface. Same UI for Phase A (backtest review) and Phase B (shadow review) — only the `run_mode` filter changes. Goal: a reviewer can clear yesterday's queue in 15–30 minutes.

Five screens:

1. Dashboard (landing)
2. Alignment Review — the 7-tab work queue
3. Rule Catalogue
4. Proposals Queue
5. Single-Ad Detail (drill-in from any screen)

---

## Screen 1 — Dashboard (landing)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  rma-ai  ▸  Dashboard                              [reviewer: Sharad ▼]      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Mode:  ( ●) Backtest    ( ) Shadow    ( ) Live      Date range: [Last 7d ▼]│
│                                                                              │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                  │
│  │  Strict alignment %      │  │  Partial-credit %        │                  │
│  │                          │  │                          │                  │
│  │       62.4 %             │  │       74.1 %             │                  │
│  │   ─────────────          │  │   ─────────────          │                  │
│  │   target ≥ 85% for 2w    │  │   strict + 0.5·partial   │                  │
│  └──────────────────────────┘  └──────────────────────────┘                  │
│                                                                              │
│  Outcome breakdown — last 7 days, 412 eligible runs                          │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │  FULL_MATCH               ████████████████        178   43%      │       │
│  │  BOTH_CLEAN               ███                      79   19%      │       │
│  │  PARTIAL_OVERLAP          ████                     48   12%      │       │
│  │  NO_OVERLAP_BOTH_FLAGGED  █                         9    2%      │       │
│  │  WE_ONLY                  ██                       33    8%      │       │
│  │  RO_ONLY                  ███                      54   13%      │       │
│  │  DATA_QUALITY             ▌                        11    3%      │       │
│  │                                                                  │       │
│  │  PENDING_RO_REVIEW (not counted)                  124            │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                              │
│  Action items today                                                          │
│    • 54 RO_ONLY rows awaiting your review     [Review →]                    │
│    • 9  NO_OVERLAP_BOTH_FLAGGED to investigate [Review →]                    │
│    • 12 rule proposals pending approval         [Open queue →]               │
│                                                                              │
│  Quick links:  [Rules catalogue]   [Backtest run report]   [Settings]        │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Screen 2 — Alignment Review (7-tab work queue)

The main daily-use screen. Each tab is a `WHERE outcome = …` filter on `editorial_check_alignment`.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  rma-ai  ▸  Alignment Review                       [reviewer: Sharad ▼]      │
├──────────────────────────────────────────────────────────────────────────────┤
│  Mode: Backtest  ▾    Date: Last 7d ▾    Category: Any ▾    Newspaper: Any ▾│
│                                                                              │
│ ┌──────────┬────────────┬────────┬─────────┬─────────────┬──────────┬──────┐│
│ │Confirms  │False pos.? │Missed  │Partial  │Different    │ Pending  │ Data ││
│ │(257)     │(33)        │(54) ●  │overlap  │things flag. │ RO rev.  │ qual.││
│ │          │            │        │(48)     │(9) ●        │ (124)    │ (11) ││
│ └──────────┴────────────┴────────┴─────────┴─────────────┴──────────┴──────┘│
│                                                                              │
│  Tab: "Missed" — RO_ONLY (we let through, RO flagged)                       │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ad #1937474  •  ChangeOfName  •  Amar Ujala  •  2026-04-09           │  │
│  │ ────────────────────────────────────────────────────────────────────  │  │
│  │ ad text:                                                              │  │
│  │   "I, khushi tyagi, D/O Vinesh tyagi, resident of Sultanpur sector   │  │
│  │   128 noida GB Nagar (201304), that my father's name was wrongly     │  │
│  │   mentioned in 10th marksheet is (Binesh Tyagi) & the correct name   │  │
│  │   is (Vinesh Tyagi)…"                            [expand ▾]          │  │
│  │                                                                       │  │
│  │ ◉ Our flags:    (none — we passed this ad)                            │  │
│  │ ◉ RO flagged:   207 "Verify Ad Content"                               │  │
│  │ ◉ RO note:      "one person can not change other person's name —      │  │
│  │                  ask client to write in proper way — read affidavit"  │  │
│  │                                                                       │  │
│  │ [ Draft a rule from this ✨ ]   [ Open ad detail ]   [ Skip (DQ) ]   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ad #1940106  •  Tender (mis-cat)  •  TOI  •  2026-05-15              │  │
│  │ ────────────────────────────────────────────────────────────────────  │  │
│  │ ad text:                                                              │  │
│  │   "Tender invited from agencies for Modernization of Passenger       │  │
│  │   Lifts of Victoria Greens Residential Complex Garia, Kolkata –      │  │
│  │   700084. Tender document available from 12/05/26 to 30/05/26…"      │  │
│  │                                                                       │  │
│  │ ◉ Our flags:    (none)                                                │  │
│  │ ◉ RO flagged:   4  "Incorrect Categorization"                         │  │
│  │ ◉ RO note:      "Tender / check cost"                                 │  │
│  │ ◉ Customer chose:  Business › Notices                                 │  │
│  │ ◉ RO implied:      Public Notice › Tender                             │  │
│  │                                                                       │  │
│  │ [ Draft a rule from this ✨ ]   [ Open ad detail ]   [ Skip (DQ) ]   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  …52 more in this tab.                                       [Load more ↓]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Per-row actions (each tab has its own action verbs)

| Tab | Action button(s) |
|---|---|
| Confirms | (no action — read-only spot-check; can mark "wrong, was actually X") |
| False positives? | `[Rule too strict — edit/disable]`, `[RO missed — note]`, `[Confirm rule]` |
| Missed | `[Draft a rule from this ✨]` (opens proposal modal pre-filled by LLM) |
| Partial overlap | `[Edit our rule]`, `[Add rule for RO's extra]`, `[Confirm partial agreement]` |
| Different things flagged | `[Investigate our flag]`, `[Add rule for RO's flag]`, `[Mark data quality]` |
| Pending RO review | (none — auto re-checks each day) |
| Data quality | `[Confirm DQ]`, `[Re-categorise]` |

### "Draft a rule from this" modal (Missed tab)

```
┌────────────────────────────────────────────────────────────────────┐
│  Draft a rule — from ad #1937474                                   │
├────────────────────────────────────────────────────────────────────┤
│  LLM has suggested:                                                │
│                                                                    │
│  Name:        [ Change of Name: cannot change another's name      ]│
│  Target reason:  [ 11 — Newspaper does not accept     ▾ ]          │
│  Rule type:  [ llm_semantic ▾ ]                                   │
│  Severity:   ( ) hard      (●) soft                                │
│  Scope — category: [ 30 Change of Name ; 34741 Change of Name × ] │
│  Scope — newspapers: [ all ▾ ]                                    │
│                                                                    │
│  Customer message (shown if this fires):                          │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Ads cannot be used to change another person's name. Each    │  │
│  │ name change must be made by that person (or their legal     │  │
│  │ guardian, if a minor) via affidavit.                         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  LLM rationale: "RO's note said 'one person cannot change another  │
│   person's name'. The ad shows a daughter declaring her father's   │
│   name correction. Affidavit must be by the person being renamed." │
│                                                                    │
│  [Approve → editorial_rule (active)]  [Save as proposal]  [Reject] │
└────────────────────────────────────────────────────────────────────┘
```

---

## Screen 3 — Rule Catalogue

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  rma-ai  ▸  Rule Catalogue                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│  [+ New rule]   Filter: [Status ▾] [Target reason ▾] [Category ▾] [Search…] │
│                                                                              │
│  ┌────┬─────────────────────────────────────┬─────────┬─────────┬──────────┐│
│  │ ID │ Name                                │ Type    │ Severity│  Fired/wk││
│  ├────┼─────────────────────────────────────┼─────────┼─────────┼──────────┤│
│  │ 12 │ Obituary: no cause of death         │regex_ban│  hard   │   34     ││
│  │ 13 │ Matrimonial: caste only if allowed  │llm_sem. │  soft   │   17     ││
│  │ 21 │ Phone must be Indian 10-digit       │format   │  hard   │   8      ││
│  │ 27 │ Word count ≤ 30 (Hindustan classfd) │word_max │  hard   │   5      ││
│  │ 31 │ No mojibake / unidentified chars    │lang_only│  hard   │   12     ││
│  │ 32 │ ChangeOfName: must include affidavit│must_cont│  hard   │   0      ││
│  │ …  │                                     │         │         │          ││
│  └────┴─────────────────────────────────────┴─────────┴─────────┴──────────┘│
│                                                                              │
│  Click row → rule editor (next page)                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

Rule editor screen (drill-in) shows full pattern/scope JSON with type-specific helpers, history of edits, and a "test this rule against ad text" sandbox.

---

## Screen 4 — Proposals Queue

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  rma-ai  ▸  Rule Proposals (12 pending)                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│  Sort: [newest ▾]   Filter: [proposed by ▾]   [Bulk reject]                  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ #347  proposed_by: llm  •  source: alignment row #8121               │  │
│  │ "ChangeOfName: cannot change another person's name"                  │  │
│  │ type: llm_semantic  •  severity: soft  •  scope: cat 30, 34741       │  │
│  │ ── [Open] ── [Approve] ── [Reject] ── [Edit] ──                      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ #346  proposed_by: 211  •  source: manual                            │  │
│  │ "Recruitment: no overseas job without document"                      │  │
│  │ type: must_contain  •  severity: hard  •  scope: cat 13, 940         │  │
│  │ ── [Open] ── [Approve] ── [Reject] ── [Edit] ──                      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Screen 5 — Single-Ad Detail (drill-in)

Reached from any list row. Shows the full lifecycle of one ad through our engine + RO.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  rma-ai  ▸  Ad #1937474                                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│  Category chosen:  Change of Name (34741)  •  Newspaper: Amar Ujala (52)     │
│  Booked:  2026-04-09 14:22  •  Publish:  2026-04-12                          │
│  ad_master.status: 5 (Confirmed for Release)  •  eligible_at: 2026-04-12     │
│                                                                              │
│  ── Ad text (snapshot at check time) ────────────────────────────────────   │
│  I, khushi tyagi, D/O Vinesh tyagi, resident of Sultanpur sector 128         │
│  noida GB Nagar (201304), that my father's name was wrongly mentioned in    │
│  10th marksheet is (Binesh Tyagi) & the correct name is (Vinesh Tyagi).     │
│  This (Binesh Tyagi) & (Vinesh Tyagi) both are the same person…             │
│                                                                              │
│  ── Our engine ──────────────────────────────────────────────────────────   │
│  Engine version: 0.1.0  •  Pass-1 (rules): 12 rules evaluated → 0 fired     │
│  Pass-2 (categorisation): chosen = inferred ✓                               │
│  Pass-3 (LLM judge): pass                                                   │
│  Verdict: PASS  •  Latency: 2,341 ms  •  LLM cost: ₹0.07                    │
│                                                                              │
│  ── RO team ─────────────────────────────────────────────────────────────   │
│  Ticket #265114  •  reason: 207 "Verify Ad Content"                         │
│  Internal note: "one person can not change other person's name —            │
│                  ask client to write in proper way — read affidavit"        │
│  Sub-reason 208: Client confirmed the ad matter  •  Fixed at 2026-04-10     │
│                                                                              │
│  ── Alignment outcome ───────────────────────────────────────────────────   │
│  RO_ONLY  (we missed it)                                                    │
│  [ Draft a rule from this ✨ ]   [ Mark data quality ]                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Notes / open questions for Sharad

- **Bulk actions on the alignment tabs** — should "approve N similar proposals at once" be a v1 feature, or single-action only?
- **Two reviewers, assignment** — should rows be auto-assigned round-robin between the two reviewers, or shared inbox with claim-on-click?
- **Localisation of customer-facing rule messages** — Phase C needs `customer_message` in the customer's own language. Easiest path: store in English, translate on-render with LLM. Defer to Phase C?
- **History of edits to a rule** — do we need an `editorial_rule_history` table from day one, or rely on `updated_at` and a future migration? My default = defer; rules are not legally consequential.
- **Mobile / responsive** — the review UI is desktop-first. OK?
