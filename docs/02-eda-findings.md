# EDA Findings — RMA Editorial Auto-Checker

_DB: `release4_rma` on `mum-db-rma...` (RDS MySQL, read-only via `ranita`). 234 tables. Investigated 2026-05-18._

---

## TL;DR — the headline reframe

**`cat_mes` is not a rules engine. It is a table of prose advisory messages shown to customers during booking (step 2 / step 3), keyed by category and newspaper.** Examples of the actual content:

> "Obituary ads must include the name of the person issuing the notice and omit any mention of the cause of death."
> "Matrimonial Advertisements In Hindu is only classified 'By Language' or 'By Profession'."
> "Wanted Brides ads are published on Saturdays & Wanted Grooms on Sundays."
> "Ad matter in 1st class magistrate letterhead is required. Ad matter must contain: 'In the court of Ld. Judicial Magistrate (1st class) at [place]…'"

These are written for a human to read and act on. They are not parseable, machine-enforceable rules. **An auto-checker cannot consume `cat_mes` directly.**

This is the single biggest finding and it changes how we build the system. More on the options below.

---

## What `cat_mes` actually is

| Field | Type | What it holds |
|---|---|---|
| `id` | PK | — |
| `category_id` | varchar | FK into `new_categories` / `ad_categories` |
| `newspaper` | text | **comma-separated list** of `np_id` values; empty = applies to all newspapers for the category |
| `msg` | text | the advisory message (HTML) — what the customer reads |
| `msg_page` | varchar | when to show it: `step2` (compose), `step3` (preview/payment), `step2_cd` / `step3_cd` (classified-display variants) |
| `doc_upload` | tinyint | whether the message includes a document-upload requirement |
| `msg_cd`, `msg3`, `title_head`, `data_msg` | — | mostly empty, secondary variants |

**Scale and shape (148 rows):**
- 84 rows shown at `step2` (compose), 48 at `step3` (preview), 6 in classified-display variants, 1 at step4
- Scope distribution: **133 rows are category × specific newspaper(s)**, 14 rows are category-only (applies to all papers), 1 row is universal. Confirms your earlier answer that the rules are 3-axis (universal / category / newspaper) with combinations.
- Newspaper-spread per rule: 68 rules target exactly 1 paper, 22 target 2–5 papers, 36 target >100 papers (effectively "applies broadly").
- Top categories by rule count: Change of Name (16 + 16 across two cat_ids), Matrimonial (16), Recruitment (10), Business (9), Property (8), Obituary, Education, Lost & Found, Court Notice, Vehicles. Roughly mirrors the categories you'd expect to have the highest editorial complexity.

**What it isn't:** there's no severity field, no rule type, no pattern/regex, no required-fields list, no banned-words array, no language tagging. It's free text addressed to the customer.

---

## The better-structured cousin: `sub_category_tips`

There's a second table I want to flag: `sub_category_tips` (79 rows). It has the same role as `cat_mes` but with **explicit structured fields**:

| Field | What |
|---|---|
| `cat_id`, `parent_cat_id`, `parent_cat_name` | category linkage |
| `why` | when/why this ad type is placed |
| `documents` | what supporting docs are required |
| `format` | what shape the ad text must take |
| `tips` | the do's and don'ts |

Example for Change of Name:
> **format**: "Change of Name ads have a particular format to follow where every detail needs to be mentioned to avoid rejection… Multiple person's Name Change in single ad text is not allowed…"
> **tips**: "1. Clearly mention old name and new name in the ad matter. 2. Mention the affidavit no in the ad matter. 3. If the person who's name is being changed is a minor, then his/her guardian should make the affidavit…"

**Caveat:** coverage is partial — many rows have empty `why`/`format`/`tips`. Looks like an effort that was started but not completed. Still — this is closer in shape to what an enforceable rule should look like than `cat_mes`.

---

## How "editorial issues" are tracked today

I couldn't find a dedicated "editorial-issues" table. Instead, the workflow is captured in the **status-machine** — `status_master` (131 codes) + `ad_status_track` (683k transition events).

Every ad goes through editorial review. In `ad_status_track`:
- **status 67 — "Undergoing Editorial Approval for Processing"** — 449,754 events (87% of as many events as the success state)
- **status 5 — "Confirmed for Release"** — 517,637 events
- **status 12 — "Payment received. Ad awaiting editorial confirmation"** — 47,034 events

So editorial review is not a 15–20% subset — it's **every** ad. The 15–20% is the share where review surfaces an issue requiring customer action.

**The editorial-issue status codes I'd treat as "needs customer fix" today:**

| Code | desc |
|---|---|
| 3 | Ad Put on Hold |
| 10 | Disapproved |
| 16 | Not Editorially Approved |
| 54 | ABP/Telegraph abbreviations not allowed |
| 56 / 75 / 77 | Change in Category |
| 57 | Change in Ad Matter |
| 58–64, 76 | Awaiting documents (Change of Name / Lost & Found / Missing / Marriage Notice / Common) |
| 72 | Ad Matter Missing Contact |
| 73 | Ad Matter Wrong Abbreviations |
| 74 | Address needed in the ad matter |
| 79 | Exceeds Word Limit |
| 90 | Awaiting Managerial Review |
| 115 | Waiting On Customer |
| 146 | Editorially Disapproved |
| 178 | Ad Matter Poor Quality |
| 180 | Matter & background image required separately |
| 182 | Matter Not Available |
| 187 | Ad Put on Hold Email |
| 221 | Improper Spacing in Ad Matter |

**This is the most useful artefact we have.** This list (a) doubles as our backtest signal — for the last 100 (or last 10,000) ads, did the ad ever hit any of these codes? — and (b) doubles as a **rule taxonomy** — every code is a category of editorial reason that already happens in the wild. If we build the auto-checker, every code on this list should map to one or more atomic rules our engine can detect.

There is also `ad_master.failure_reason` (varchar 2500, ~775 of 29k current ads populated, ~23.5k of 921k archive ads). Sampled values are noisy — "any", "0", "any" — not a clean signal source. Skip.

---

## Where the ad text lives

`ad_master.ad_text` — the column we'd check.
- 29,393 rows in the live table; 648,607 in `ad_master_archive`
- Text is **multilingual** — confirmed Hindi, Bengali, Gujarati, English in 5-row sample
- Classified-display ads also use `cd_header_text`, `cd_body_text`, `cd_footer_text`
- `ad_master.category` is a comma-separated tuple `top_cat,sub_cat,sub_sub_cat,sub_sub_sub_cat` (e.g. `9,495,641,34734` = Matrimonial → … → newspaper-specific subcat). The first integer is the top-level category in `ad_categories` / `new_categories`.

---

## How to compute the real "editorial issue rate"

We can replace your 15–20% guess with a real number. Single query:

```sql
SELECT
  COUNT(DISTINCT ast.ad_id) AS ads_with_editorial_issue,
  (SELECT COUNT(*) FROM ad_master_archive WHERE creation_date BETWEEN ...) AS total_ads,
  COUNT(DISTINCT ast.ad_id) * 100.0 / (SELECT COUNT(*) ...) AS pct
FROM ad_status_track ast
WHERE ast.c_status IN (3,10,16,54,56,57,72,73,74,79,90,146,178,180,182,221,…)
  AND ast.added_date BETWEEN '2025-01-01' AND '2025-12-31';
```

I haven't run this yet — wanted to align on the status-code list with you first. (Some codes like 56 "Change in Category" or 90 "Awaiting Managerial Review" are ambiguous about whether they count as "editorial issue" for our purposes.)

---

## The architectural choice this opens up

Given that the rules table is prose, three paths forward:

### Option A — LLM judge with prose-as-context

For each booking, look up the relevant `cat_mes` rows for `(category_id, newspaper_id, msg_page)`, concatenate them as context, and ask the LLM to evaluate the ad text against them.

- **Pro:** zero data migration, leverages 15 years of accumulated knowledge already in the table, picks up nuance.
- **Con:** non-deterministic, LLM cost on every booking, harder to debug "why was this blocked", weak guarantees.

### Option B — Structured rules engine (one-time extraction)

Run an LLM-assisted pass over the 148 `cat_mes` rows + 79 `sub_category_tips` rows to extract atomic rules into a new table — e.g.:

```
rule_id | type        | scope_cat | scope_papers | pattern                           | severity | message
--------|-------------|-----------|--------------|-----------------------------------|----------|----------
101     | regex_ban   | 10        | all          | (cause of death|died of|due to..) | hard     | Obituary ads must not mention cause of death
102     | must_contain| 10        | all          | <name_of_issuer_present>          | hard     | Obituary ads must name the person issuing the notice
103     | regex_ban   | 9         | TOI,Hindu    | (caste|gotra|community)           | soft     | Matrimonial: some papers don't allow caste/community
104     | contact_fmt | 16        | all          | <indian_10digit OR intl_w_cc OR..>| hard     | Situation Wanted: contact must be 10-digit Indian/intl/email/URL
```

- **Pro:** fast, cheap, deterministic, debuggable, reviewable by your team.
- **Con:** one-time extraction effort + ongoing rule maintenance. Some rules don't fit clean patterns ("ad matter format must be …" needs semantic check).

### Option C — Hybrid (recommended)

- Pass 1, deterministic rules engine: handles the clean cases — banned words/phrases, must-include-phone, format checks, word-count, language, document-required flags. Catches ~60–80% of issues at zero cost.
- Pass 2, LLM judge: only runs on ads that pass Pass 1, with the relevant prose messages as context. Catches the semantic and nuanced cases.
- Both layers feed the same response shape (hard-block / soft-warn / pass) with reasons that map back to a rule_id or a `cat_mes.id`.

This matches what you said earlier — "rules first, LLM second layer."

---

## What I still need from you

1. **Status-code list** — does the editorial-issue code list above match how your ops team thinks about it? Are there codes I've misclassified or missed?
2. **`sub_category_tips`** — was this an abandoned attempt, an in-progress effort, or actively maintained? Should the auto-checker treat it as a richer source than `cat_mes` or ignore it?
3. **Backtest scope** — "last 100 ads" feels small for confidence given the multi-category × multi-newspaper × multi-language space. Could we agree on last 1,000 (or last 30 days, all ads) for the validation step?
4. **Multilingual ads** — given the existing ads are in 8+ Indian languages but the rules are in English, do you want the checker to handle non-English ads from day one, or English-first and expand? (Hard-block on non-English would be a non-starter.)
5. **Where the customer fixes the issue** — when our checker flags a hard-block, the customer is mid-flow at step 2. They need to know *which sentence/phrase* in their ad triggered the rule, not just "your ad has an issue." Do you want us to surface specific span highlights, or is "rule X violated" enough as v1?

Once we align on the path (A/B/C) and the answers above, I'll draft the implementation plan.

---

# Addendum (2026-05-18, after Sharad's clarifications)

## Scope updates Sharad confirmed
- `sub_category_tips` → out of v1. Phase-2 idea: infer correct subcategory from ad matter and confirm/correct customer's choice.
- Multilingual support required in v1.
- Backtest scope → last 2,000 ads.
- 3-phase rollout: build → internal review UI on live new ads (team validates daily) → customer-facing front-end (web + mobile).
- Status codes from `ad_status_track` are de-prioritised: status is a snapshot that gets overwritten as the ad's journey progresses, so it loses history.

## The real ground-truth tables — `forum_report_email_master` + `forum_report_email`

The Customer Care CRM tables, pointed to by Sharad. This is where every ops-flagged issue is logged.

**`forum_report_email_master`** — 282,761 rows (one row = one issue ticket against one ad)

| Field | What |
|---|---|
| `id` | PK |
| `ad_id` | FK to ad_master.ad_id |
| `np_id` | newspaper id |
| `reason` | int FK into `ro_reason` — **the issue category** |
| `sub_reason` | int FK into `ro_reason` — **the resolution outcome** |
| `priority` | priority code |
| `status` | ticket workflow status |
| `assign_by`, `assing_to`, `fixed_by` | admin user IDs (note the `assing_to` typo in the column name) |
| `reporting_time`, `suppose_to_fix`, `fixed_time` | SLA timestamps |
| `feedback_email`, `feedback_points`, `feedback_comment` | post-resolution feedback |
| `generated_by` | source/admin who created the ticket |

**`forum_report_email`** — 566,276 rows (child of master via `report_ro_id`; type column splits into):

- `type='note'` — internal ops note describing the issue (~210k rows) — the **most useful** signal for our auto-checker
- `type='reply'` / `type='email'` — outbound communication to the customer (~150k+150k rows)
- `type='re-report'` — reopened tickets (537 rows)

## The reason taxonomy — `ro_reason` (216 rows)

This is the canonical issue-type lookup, with a hierarchical structure: top-level rows have `parent_id='0'` or `'no_any'`, child rows have `parent_id` pointing to the parent. The top-level row = "what was wrong"; the child row = "how it was resolved".

Top reason codes decoded:

| code | n (lifetime) | name | editorial-content? |
|---|---|---|---|
| 6 | 37,026 | Awaiting Documents | no (separate workflow) |
| 5 | 25,416 | Ad Missed Verification | no (post-publish) |
| **109** | **21,974** | **Spam** | **yes** |
| **4** | **21,934** | **Incorrect Categorization** | **yes** |
| 21 | 19,099 | FAQ | no |
| **10** | **17,230** | **Edit Ad Matter** | **yes** (mostly) |
| **11** | **17,216** | **Newspaper does not accept** | **yes** |
| 9 | 16,563 | Reschedule | no |
| 140 | 16,313 | Already tagged previously | no (meta) |
| 19 | 8,656 | Wrongly charged | no |
| **207** | **7,489** | **Verify Ad Content** | **yes** |
| 17 | 6,670 | To be sent for designing | no |
| 14 | 6,124 | Cancellation | no |
| 117 | 5,806 | Receive After Deadline | no |
| 106 | 5,009 | Updating dates (wrong selection) | borderline |
| 104 | 4,466 | Payment query | no |
| 108 | 4,362 | Forward to Acq | no |
| **1** | **4,319** | **Ad Matter Missing Contact** | **yes** |
| 148 | 4,196 | High Value Ad Verification | borderline |
| 20 | 3,978 | Wrongly printed | no |
| **13** | **3,183** | **Improper Spacing** | **yes** |
| **12** | **3,181** | **Exceeds word limit** | **yes** |
| 3 | 2,946 | Additional Payment | no |
| **150** | **2,877** | **Category Missing** | **yes** |
| 139 | 2,470 | Internal RMA Communication | no |
| 146 | 2,301 | Design Issue | no (display ad design) |
| **137** | **1,320** | **Editorially Disapproved** | **yes** |
| 16 | 1,126 | Site booking error | no |
| **2** | **906** | **Ad Matter wrong abbreviations** | **yes** |
| **18** | **260** | **Unidentified characters in the ad text** | **yes** |

**Twelve editorial-content reasons (the auto-checker's target):**
`1, 2, 4, 10, 11, 12, 13, 18, 109, 137, 150, 207`

**Lifetime total: ~102,000 editorial tickets** (36% of all 282k tickets are editorial-content; the rest are billing, cancellation, payment, design, document-upload, etc.)

## Sample of editorial-flagged ads + actual ops notes (last 90 days)

Real examples — these are exactly the labels for our backtest:

| ad_text (truncated) | flagged_as | ops note |
|---|---|---|
| "Tender invited from agencies for Modernization of Passenger Lifts of Victoria Greens…" | Incorrect Categorization | "Tender / check cost" |
| "Brahmin, born 1985, well-settled with a highly reputed government job in Rajkot, seeks a suitable match from a cultured Brahmin and **any upper cast family**…" | Edit Ad Matter | (empty — customer-requested edit) |
| "I, MARYAM SAHAR D/o MOHAMMAD SABIR… declare MOHAMMAD SABIR (correct) and MOHD SABIR are the same person." | Verify Ad Content | "How much time will it take…" (customer reply mis-tagged) |
| "2 BHK 2 TOILET 1200 SQ FEET 3RD FLOOR APP PARK AND POOL FAC IN SOCORRO GARDENS PORVORIM GOA…" | Category Missing | "sub category missing" |
| "I ,khushi tyagi , D/O Vinesh tyagi… that my father's name was wrongly mentioned in 10th marksheet…" | Verify Ad Content | "**one person can not change other person's name** / ask client to write in proper way / read affidavit" |
| "Lost my marksheet 10 12 class at rampur fatehabad agra…" | Lost (under Verify Ad Content) | "**also gd/fir reqd**" |
| "Central Govt.--- need to remove this part" (recent note from 282917) | reason=11 Newspaper does not accept | "Central Govt.--- need to remove this part" |
| "5 dates are missing..Also verify ahe" (recent note) | reason=106 Updating dates | format/spacing concern |
| "DOB can not be changed, can be corrected" (recent note) | reason=11 | semantic rule about change-of-name |

Note these notes are noisy:
- Internal shorthand ("Tender / check cost", "GD/FIR reqd")
- Some are customer replies mis-tagged as `note`
- Some are empty when the issue is self-evident from the reason code

For the backtest, we'll filter by `(reason IN editorial-codes) AND (note length > 20 chars OR reason ∈ very-clean-subset)` to get a usable dataset.

## Real editorial-content issue rate

The earlier "18%" number conflated all CRM issues. The clean editorial-content rate is meaningfully lower:

- **Lifetime estimate**: ~102k editorial tickets / 950k total ads ≈ **6–10%** of ads see at least one editorial ticket
- (Window-based queries gave unreliable numbers because `ad_master.creation_date` is a `varchar(50)`, so DATE comparisons are quirky. Precise rate is milestone 1 of phase 0.)

A 6–10% rate still translates to ~50–100 ads per day across RMA volume, which is a meaningful ops cost to remove.

## What this means for the design

The architecture path stays the same — **hybrid (Option C): structured rules engine first pass + LLM judge second pass**. But the rule-source story is now cleaner:

1. **Static knowledge** lives in `cat_mes` (148 prose rules) and `sub_category_tips` (79 partial structured rules) — both written for humans, both useful as LLM context or as input to a one-time extraction.
2. **Ground-truth labels** live in `forum_report_email_master` (editorial-reason rows) + `forum_report_email` (notes). This is what we backtest against.
3. **Taxonomy** comes from `ro_reason` — the 12 editorial codes give us natural rule buckets:
   - Missing contact (reason 1)
   - Wrong abbreviations (reason 2)
   - Incorrect/missing categorization (reasons 4, 150)
   - Edit ad matter (reason 10 — catch-all)
   - Newspaper does not accept (reason 11 — pub-specific bans)
   - Exceeds word limit (reason 12)
   - Improper spacing (reason 13)
   - Unidentified characters (reason 18)
   - Spam (reason 109)
   - Editorially disapproved (reason 137 — generic editorial)
   - Verify ad content (reason 207 — semantic/intent check, e.g., the "one person can't change another's name" rule)

Each of these maps to one or more rules our engine implements. We don't need to invent the taxonomy — RMA already lived through it.

The implementation plan is in `03-implementation-plan.md`.

