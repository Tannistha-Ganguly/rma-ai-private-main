#!/usr/bin/env python3
"""Apply a SQL migration file to rma_ai.

Usage:
    RMA_AI_HOST=... RMA_AI_USER=... RMA_AI_PASS=... \
    python3 scripts/apply_migration.py sql/migrations/001_initial_schema.sql
"""
import os, sys, pymysql, re

if len(sys.argv) != 2:
    print("usage: apply_migration.py <path_to_sql_file>", file=sys.stderr)
    sys.exit(1)

sql_path = sys.argv[1]
with open(sql_path) as f:
    sql = f.read()

# Strip line comments (-- ...) and split on semicolons that end statements.
sql_clean = re.sub(r"--[^\n]*", "", sql)
statements = [s.strip() for s in sql_clean.split(";") if s.strip()]

conn = pymysql.connect(
    host=os.environ["RMA_AI_HOST"],
    user=os.environ["RMA_AI_USER"],
    password=os.environ["RMA_AI_PASS"],
    db="rma_ai",
    connect_timeout=10,
    charset="utf8mb4",
)
print(f"Applying {len(statements)} statement(s) from {sql_path}...")
with conn.cursor() as c:
    for i, stmt in enumerate(statements, 1):
        first_line = stmt.split("\n", 1)[0][:90]
        print(f"  [{i}/{len(statements)}] {first_line}...")
        c.execute(stmt)
conn.commit()
print("Migration applied. Verifying:")
with conn.cursor() as c:
    c.execute("SHOW TABLES")
    for (t,) in c.fetchall():
        print(f"  - {t}")
conn.close()
