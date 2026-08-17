#!/usr/bin/env python3
"""One-shot starter-rule extraction.

Reads release4_rma.cat_mes (148 prose advisories) and release4_rma.sub_category_tips
(79 partial structured tips), asks Claude Haiku 4.5 to extract atomic machine-
checkable rules, writes them to rma_ai.editorial_rule_proposal with status='pending'.

Run once at Phase A start. Sharad + team approve/reject/edit each proposal via the
review UI (or, for the bootstrap pass, directly in the table).

Usage:
    cp .env.local.example .env.local && fill in real values
    python3 scripts/extract_starter_rules.py [--limit N] [--dry-run]

Env vars required: RMA_HOST, RMA_USER, RMA_PASS (release4_rma read access),
                   RMA_AI_HOST, RMA_AI_USER, RMA_AI_PASS (rma_ai write access),
                   ANTHROPIC_API_KEY
"""
from __future__ import annotations
import os, sys, json, argparse, time
import pymysql
from anthropic import Anthropic

EDITORIAL_REASONS = {
    1:   "Ad Matter Missing Contact",
    2:   "Ad Matter wrong abbreviations",
    4:   "Incorrect Categorization",
    10:  "Edit Ad Matter",
    11:  "Newspaper does not accept",
    12:  "Exceeds word limit",
    13:  "Improper Spacing",
    18:  "Unidentified characters in the ad text",
    109: "Spam",
    137: "Editorially Disapproved",
    150: "Category Missing",
    207: "Verify Ad Content",
}

EXTRACTION_PROMPT = """You are helping convert a prose advisory message from a newspaper-ad booking platform's editorial guidelines into a set of atomic, machine-checkable rules.

Context:
- The platform is releaseMyAd (RMA), India's largest online newspaper ad booking service.
- The advisory below is shown to customers at booking time, or to internal ops as a guideline.
- We are building an auto-checker that catches editorial issues at submission time, against the same rules ops applies today.
- Rules must target one of these "ro_reason" categories that ops uses to flag issues:
{reasons_list}

Output: a JSON array of zero or more rule objects. Each object has:
- "name": short rule name (≤120 chars)
- "description": internal — what the rule does and why
- "customer_message": what the customer sees if this rule fires (clear, kind, actionable)
- "rule_type": one of [regex_ban, must_contain, word_count_max, word_count_min, language_only, format_pattern, category_match, llm_semantic, custom_function]
- "pattern": JSON object — for regex_ban: {{"regex": "..."}}, for must_contain: {{"patterns": ["..."]}}, for word_count_max: {{"max": 30}}, for word_count_min: {{"min": 5}}, for language_only: {{"scripts": ["Latin", "Devanagari"]}}, for llm_semantic: {{"check_prompt": "..."}}, etc.
- "category_scope": JSON array of category_ids the rule applies to, or null for all
- "np_scope": JSON array of np_ids the rule applies to, or null for all
- "target_ro_reason": integer — which ro_reason this rule addresses (must be from the list above)
- "severity": "hard" (block, customer must fix) or "soft" (warn, customer can ack and proceed)

Guidelines:
- Prefer deterministic types (regex_ban, must_contain, word_count_max, format_pattern) over llm_semantic when possible.
- Only emit llm_semantic when the rule genuinely requires understanding (e.g., "one person can't change another person's name").
- If the advisory is purely informational (e.g., "publication is on Saturdays") and not a content rule, return [].
- If the advisory is about document upload requirements (not text content), return [] — that's a separate workflow.
- One advisory can yield multiple rules. Split aggressively.
- Be conservative on severity. Default to "soft" unless the advisory clearly says "must" / "required" / "not allowed".

Advisory to convert:
─────────────────────────────────────
Source table: {source_table}
Source row id: {source_id}
Category id(s): {category_id}
Newspaper id(s): {newspaper}
Page shown on: {page}
Advisory text:
{advisory_text}
─────────────────────────────────────

Return ONLY the JSON array. No prose, no markdown fence."""


def fetch_advisories(conn, source: str, limit: int | None):
    """Pull rows from cat_mes or sub_category_tips."""
    if source == "cat_mes":
        sql = """
            SELECT id, category_id, newspaper, msg_page, msg
            FROM cat_mes
            WHERE CHAR_LENGTH(msg) > 20
            ORDER BY id
        """
    else:  # sub_category_tips
        sql = """
            SELECT id, cat_id AS category_id, '' AS newspaper, 'tips' AS msg_page,
                   CONCAT_WS('\n\n',
                       CASE WHEN why != '' THEN CONCAT('WHY: ', why) END,
                       CASE WHEN format != '' THEN CONCAT('FORMAT: ', format) END,
                       CASE WHEN tips != '' THEN CONCAT('TIPS: ', tips) END,
                       CASE WHEN documents != '' THEN CONCAT('DOCS: ', documents) END
                   ) AS msg
            FROM sub_category_tips
            WHERE (why != '' OR format != '' OR tips != '')
            ORDER BY id
        """
    if limit:
        sql += f" LIMIT {limit}"
    with conn.cursor(pymysql.cursors.DictCursor) as c:
        c.execute(sql)
        return c.fetchall()


def strip_html(html: str) -> str:
    import re
    text = re.sub(r"<[^>]+>", " ", html or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def call_claude(client, advisory: dict, source_table: str) -> list:
    reasons_list = "\n".join(f"  - {k}: {v}" for k, v in EDITORIAL_REASONS.items())
    advisory_text = strip_html(advisory["msg"])
    prompt = EXTRACTION_PROMPT.format(
        reasons_list=reasons_list,
        source_table=source_table,
        source_id=advisory["id"],
        category_id=advisory["category_id"] or "(none)",
        newspaper=advisory.get("newspaper") or "(all)",
        page=advisory.get("msg_page") or "(n/a)",
        advisory_text=advisory_text,
    )
    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text.strip()
    # Tolerate occasional markdown fencing
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0]
    return json.loads(raw)


def insert_proposals(conn, rules: list, source_table: str, source_id: int):
    source_tag = "cat_mes_extract" if source_table == "cat_mes" else "sub_cat_tips_extract"
    source_cat_mes_id = source_id if source_table == "cat_mes" else None
    with conn.cursor() as c:
        for rule in rules:
            payload = {
                "name": rule.get("name"),
                "description": rule.get("description"),
                "customer_message": rule.get("customer_message"),
                "rule_type": rule.get("rule_type"),
                "pattern": rule.get("pattern"),
                "category_scope": rule.get("category_scope"),
                "np_scope": rule.get("np_scope"),
                "target_ro_reason": rule.get("target_ro_reason"),
                "severity": rule.get("severity"),
                "source": source_tag,
                "source_cat_mes_id": source_cat_mes_id,
            }
            c.execute("""
                INSERT INTO editorial_rule_proposal
                    (proposed_by, proposed_payload, source_cat_mes_id, source_table,
                     status, notes, created_at)
                VALUES (%s, %s, %s, %s, 'pending', %s, NOW())
            """, ("llm", json.dumps(payload), source_cat_mes_id, source_tag,
                  f"Auto-extracted from {source_table}#{source_id}"))
    conn.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="Process only N rows per source (smoke test)")
    ap.add_argument("--source", choices=["cat_mes", "sub_category_tips", "both"], default="both")
    ap.add_argument("--dry-run", action="store_true", help="Print proposed rules; do not write to DB")
    args = ap.parse_args()

    for key in ("RMA_HOST","RMA_USER","RMA_PASS","RMA_AI_HOST","RMA_AI_USER","RMA_AI_PASS","ANTHROPIC_API_KEY"):
        if not os.environ.get(key):
            sys.exit(f"Missing env var: {key}")

    rma = pymysql.connect(host=os.environ["RMA_HOST"], user=os.environ["RMA_USER"],
                          password=os.environ["RMA_PASS"], db="release4_rma",
                          connect_timeout=15, charset="utf8mb4")
    rma_ai = pymysql.connect(host=os.environ["RMA_AI_HOST"], user=os.environ["RMA_AI_USER"],
                             password=os.environ["RMA_AI_PASS"], db="rma_ai",
                             connect_timeout=15, charset="utf8mb4")
    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    sources = ["cat_mes", "sub_category_tips"] if args.source == "both" else [args.source]
    total_advisories = 0
    total_rules = 0

    for source in sources:
        rows = fetch_advisories(rma, source, args.limit)
        print(f"\n=== {source}: {len(rows)} advisories ===")
        for i, row in enumerate(rows, 1):
            try:
                rules = call_claude(client, row, source)
            except Exception as e:
                print(f"  [{i}/{len(rows)}] id={row['id']} — ERROR: {e}")
                continue
            total_advisories += 1
            total_rules += len(rules)
            print(f"  [{i}/{len(rows)}] id={row['id']} → {len(rules)} rule(s)")
            if args.dry_run:
                for r in rules:
                    print(f"      • {r.get('name')} [{r.get('severity')}/{r.get('rule_type')}] → reason {r.get('target_ro_reason')}")
            else:
                insert_proposals(rma_ai, rules, source, row["id"])
            time.sleep(0.4)  # gentle rate-limit

    print(f"\nDone. {total_advisories} advisories processed, {total_rules} proposed rules.")
    if not args.dry_run:
        print(f"View pending proposals: SELECT id, proposed_payload FROM rma_ai.editorial_rule_proposal WHERE status='pending';")

if __name__ == "__main__":
    main()
