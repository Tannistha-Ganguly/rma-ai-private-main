import Link from 'next/link';
import { notFound } from 'next/navigation';
import { queryRmaAi } from '@/lib/db/rmaAi';
import { RuleEditForm } from './RuleEditForm';

interface RuleDetail {
  id: number;
  name: string;
  description: string;
  customer_message: string;
  rule_type: string;
  pattern: unknown;
  hard_category_scope: unknown;
  hard_np_scope: unknown;
  soft_category_scope: unknown;
  soft_np_scope: unknown;
  severity: 'hard' | 'soft';
  target_ro_reason: string | null;
  source: string;
  source_cat_mes_id: number | null;
  status: 'active' | 'disabled' | 'proposed';
  created_at: string;
  updated_at: string | null;
}

function asJson(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

export default async function RuleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = Number(id);
  if (!Number.isFinite(ruleId)) notFound();

  const rows = await queryRmaAi<RuleDetail>(
    `SELECT id, name, description, customer_message, rule_type, pattern,
            hard_category_scope, hard_np_scope, soft_category_scope, soft_np_scope, severity, target_ro_reason, source,
            source_cat_mes_id, status, created_at, updated_at
     FROM editorial_rule WHERE id = ?`,
    [ruleId],
  );
  if (rows.length === 0) notFound();
  const rule = rows[0];

  const { fetchRoReasons, fetchAllCategories, fetchAllNewspapers } = await import('../../actions');
  const [allReasons, allCategories, allNewspapers] = await Promise.all([
    fetchRoReasons(),
    fetchAllCategories(),
    fetchAllNewspapers(),
  ]);

  return (
    <>
      <div className="flex" style={{ marginBottom: 8 }}>
        <Link href="/rules">← Back to rules</Link>
        <div className="spacer" />
        <span className="badge">{rule.rule_type}</span>
        <span className="badge">{rule.status}</span>
      </div>

      <h1>Rule #{rule.id} — {rule.name}</h1>
      <p className="muted">
        Created: {String(rule.created_at)} · Updated: {String(rule.updated_at ?? '—')} · Source: <code>{rule.source}</code>{rule.source_cat_mes_id ? ` (cat_mes #${rule.source_cat_mes_id})` : ''}
      </p>

      <RuleEditForm
        rule={{
          id: rule.id,
          name: rule.name,
          description: rule.description,
          customer_message: rule.customer_message,
          pattern: asJson(rule.pattern),
          severity: rule.severity,
          hard_category_scope: asJson(rule.hard_category_scope),
          hard_np_scope: asJson(rule.hard_np_scope),
          soft_category_scope: asJson(rule.soft_category_scope),
          soft_np_scope: asJson(rule.soft_np_scope),
          target_ro_reason: rule.target_ro_reason ? (typeof rule.target_ro_reason === 'string' ? JSON.parse(rule.target_ro_reason) : rule.target_ro_reason) : [],
        }}
        ruleType={rule.rule_type}
        allReasons={allReasons}
        allCategories={allCategories}
        allNewspapers={allNewspapers}
      />
    </>
  );
}
