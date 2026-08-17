# Feature Gaps — Based on First Use

Gaps identified from running the full workflow end-to-end: extract → approve → backtest → review. Ordered by pain level. None are blockers for Phase B, but several will slow the review team down within a week.

---

## P0 — Blockers for sustained review velocity

### 1. No "Draft a rule from this ad" on the review screen
The wireframe specified a "Draft a rule from this ✨" button on RO_ONLY rows. It's not implemented yet. Right now, a reviewer who sees an RO_ONLY case and wants to create a rule must:
- Mentally draft the rule
- Navigate to `/proposals`... which has no "create" button
- Or go to `/rules`... which also has no "create" button

**Fix:** Add a server action `draftRuleFromAlignment(alignmentId)` that calls Haiku with the ad text + RO reason + relevant cat_mes context and inserts a proposal with `source_alignment_id` set. Surface as a button on the RO_ONLY and WE_ONLY cards in `/review`.

---

### 2. No way to create a rule manually
There's no "New rule" or "New proposal" button anywhere. Reviewers can only work with what the LLM extracted. If they spot a pattern that Haiku missed, they have no path to encode it.

**Fix:** Add a `/proposals/new` page with a simple form: name, description, customer_message, rule_type, severity, pattern (JSON editor), target_ro_reason. Pre-fill as much as possible.

---

### 3. Backtest only has 71 ads — too small for reliable alignment numbers
The join between `ad_master_update` (pre-edit text) and `forum_report_email_master` (RO tickets) only matched 71 ads. We expected ~1,500+. The `editorial_check_alignment` table has 71 rows.

At 71 ads, a single rule change can swing alignment by 1.4%. This makes the % metric noisy and hard to trust.

**Fix (investigation first):** Run this query to understand the gap:
```sql
SELECT COUNT(*) FROM ad_master_update amu
JOIN forum_report_email_master fem ON amu.booking_ref_no = fem.booking_id
WHERE fem.reason_id IN (1,2,4,10,11,12,13,18,109,137,150,207);
```
The join condition in `scripts/backtest.ts` may be on the wrong key. If the real match count is higher, fixing the join key will give us a much richer corpus without any new data collection.

---

## P1 — Significant friction after first week of use

### 4. No bulk approve/reject on proposals
368 proposals, reviewed one at a time. The proposals page has no "approve all from cat_mes" or "select + bulk approve" action. With 2 reviewers spending ~2 hours, this is manageable once but becomes painful on re-extractions.

**Fix:** Add checkboxes + "Approve selected" / "Reject selected" bulk actions to `/proposals`. Keep individual review for proposals tagged `severity: hard` — only `soft` ones should be bulk-approvable.

---

### 5. No "test this rule against an ad" feature
After approving a rule, there's no way to sanity-check it without running a full backtest. Reviewers can't paste an ad and see if the rule fires as expected.

**Fix:** Add a `/rules/[id]/test` panel (or inline on the rule detail page) — a textarea where the reviewer pastes ad text and hits "Run this rule" to see the output. This is especially important for `llm_semantic` rules where the check_prompt behaviour isn't obvious.

---

### 6. Proposals don't show example ads from the source advisory
A proposal card shows the extracted rule but not the original `cat_mes` advisory it came from. Reviewers are approving rules without seeing the source context.

**Fix:** Show the source advisory text (from `cat_mes.msg` via `source_cat_mes_id`) collapsed/expandable on each ProposalCard. Requires a single extra JOIN — `cat_mes` is already in `release4_rma`.

---

### 7. Dashboard has no trend over time
The dashboard shows aggregate alignment % (one number for all backtest runs, or all shadow runs). It doesn't show how that number has changed over the past N runs.

**Fix:** Add a sparkline or simple table of the last 10 runs: date, run_mode, ads checked, strict alignment %. This lets the team see if they're improving or regressing after each rule change.

---

### 8. Review queue has no search/filter beyond tabs
The review tabs give you one filter (outcome bucket). If a reviewer wants to focus on "all RO_ONLY rows where reason_id = 10" or "all WE_ONLY rows that fired rule #42", there's no way to do it.

**Fix:** Add a filter bar above the review list: filter by `ro_reason_id`, by `our_rule_id`, by category, by date range. Even just ro_reason filter would help a lot (reason 10 alone is 75% of our RO_ONLY backtest misses).

---

## P2 — Nice to have for Phase B

### 9. No reviewer assignment / seen-by tracking
Multiple reviewers see the same queue. No way to know who's working on which row, or if something has already been looked at and intentionally skipped.

**Fix:** A simple "Assign to me" action on review rows, surfaced as a filter ("Show unassigned" / "Show mine"). The `editorial_check_alignment.reviewed_by` field already exists — just needs to be surface in the queue.

---

### 10. No per-reason alignment breakdown on the dashboard
Dashboard shows total alignment % but not "for reason 10, our alignment is X%; for reason 4, it's Y%". Drilling into which reason codes are dragging the number down is a key workflow.

**Fix:** Expand the dashboard outcome table to show a second tab or section with per-reason breakdown: reason name, total RO flags, FULL_MATCH count, alignment % for that reason.

---

### 11. Rules page doesn't link to the ads that fired them
The rules page shows fire counts per rule but clicking a rule only shows the edit form. There's no way to see "which specific ads triggered rule #12, and was it correct each time?"

**Fix:** Add a "See X firings" link from the rule detail page that filters the review queue to rows where `our_rule_ids` contains this rule ID.

---

### 12. No notification when shadow mode finds a new unseen pattern
Once shadow mode is running, there will be days when alignment drops because a new type of editorial issue appears that we've never encoded. Today that would only be visible if someone opens the dashboard and notices.

**Fix (Phase B):** A simple daily email/Slack digest: "Yesterday's shadow run — N ads checked, strict alignment X%, Y new RO_ONLY rows added." Can be a cron script that queries the DB and sends via email.

---

### 13. `ADMIN_PASSWORD` is the same for everyone
There's one shared password and no user accounts. This means the `reviewed_by` field in `editorial_check_alignment` always gets "admin" — no way to know which reviewer made which decision.

**Fix:** Add a minimal user table (just name + password hash, 2–3 rows) so reviewer identity is tracked. Not a full auth system — just enough to attribute decisions.

---

## Summary table

| # | Gap | Effort | Phase needed by |
|---|---|---|---|
| 1 | Draft rule from review row | Medium | B |
| 2 | Create rule manually | Small | B |
| 3 | Backtest corpus only 71 ads | Investigation | A / Now |
| 4 | Bulk approve proposals | Small | B |
| 5 | Test rule against ad | Medium | B |
| 6 | Show source advisory on proposals | Small | B |
| 7 | Dashboard trend over time | Small | B |
| 8 | Review queue filter by reason/rule | Medium | B |
| 9 | Reviewer assignment | Small | B |
| 10 | Per-reason alignment breakdown | Small | B |
| 11 | Rules → firing ads link | Small | B |
| 12 | Daily shadow digest | Small | B |
| 13 | Per-reviewer accounts | Medium | C |
