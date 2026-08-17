'use server';

import { queryRma, executeRmaWrite } from '@/lib/db/rma';
import { queryRmaAi } from '@/lib/db/rmaAi';
import type { Rule } from '@/lib/engine/types';

export interface CustomerCareStats {
  total_tickets: number;
  open_tickets: number;
  true_positives: number;
  false_positives: number;
}

export interface RecentTicket {
  id: number;
  ad_id: number;
  status: string;
  reason: string;
  reporting_time: string;
  fixed_time: string | null;
  fixed_by: number;
  feedback_comment: string;
  admin_name: string;
  newspaper_name: string;
  category_name: string;
  explanation: string;
  ad_text: string;
  ad_status: string;
  cc_reply: string;
  rules_fired_names: string;
}

export interface RuleValidationStat {
  rule_id: number;
  rule_name: string;
  true_positives: number;
  false_positives: number;
  open_tickets: number;
}

export type TimeRange = '24h' | '48h' | '72h' | 'all';

function getTimeCondition(range: TimeRange, tableAlias: string): string {
  switch (range) {
    case '24h': return `AND ${tableAlias}.reporting_time >= NOW() - INTERVAL 24 HOUR`;
    case '48h': return `AND ${tableAlias}.reporting_time >= NOW() - INTERVAL 48 HOUR`;
    case '72h': return `AND ${tableAlias}.reporting_time >= NOW() - INTERVAL 72 HOUR`;
    default: return '';
  }
}

export async function fetchCustomerCareStats(range: TimeRange = 'all'): Promise<CustomerCareStats> {
  const timeCond = getTimeCondition(range, 'm');
  const stats = await queryRma<any>(`
    SELECT 
        COUNT(*) as total_tickets,
        SUM(CASE WHEN m.status = '1' THEN 1 ELSE 0 END) as open_tickets,
        SUM(CASE WHEN m.status = '3' AND IFNULL(LOWER(rr.name), '') != 'incorrectly reported' THEN 1 ELSE 0 END) as true_positives,
        SUM(CASE WHEN m.status = '3' AND LOWER(rr.name) = 'incorrectly reported' THEN 1 ELSE 0 END) as false_positives
    FROM forum_report_email_master m
    JOIN forum_report_email e ON m.id = e.report_ro_id
    LEFT JOIN ad_master am ON m.ad_id = am.ad_id
    LEFT JOIN ro_reason rr ON rr.id = IF(m.sub_reason != '', m.sub_reason, m.reason)
    WHERE m.generated_by = '6' AND m.id >= 283800 AND m.ad_id != 1944555 AND e.email LIKE 'Blocked by Editorial Checker%' AND (am.status IS NULL OR am.status != '1')
    ${timeCond}
  `);
  
  if (stats.length === 0) {
    return { total_tickets: 0, open_tickets: 0, true_positives: 0, false_positives: 0 };
  }
  
  return {
    total_tickets: Number(stats[0].total_tickets || 0),
    open_tickets: Number(stats[0].open_tickets || 0),
    true_positives: Number(stats[0].true_positives || 0),
    false_positives: Number(stats[0].false_positives || 0),
  };
}

export async function fetchRecentCustomerCareTickets(limit = 50, offset = 0, range: TimeRange = 'all'): Promise<RecentTicket[]> {
  const timeCond = getTimeCondition(range, 'f');
  const recent = await queryRma<any>(`
    SELECT 
        f.id, f.ad_id, f.status, f.reason, f.reporting_time, f.fixed_time, f.fixed_by, f.feedback_comment,
        a.full_name as admin_name,
        n.title as newspaper_name,
        nc.category_name,
        e.email as explanation,
        am.ad_text,
        sm.\`desc\` as ad_status,
        (SELECT email FROM forum_report_email fre WHERE fre.report_ro_id = f.id AND fre.email NOT LIKE 'Blocked by Editorial Checker%' ORDER BY fre.id DESC LIMIT 1) AS cc_reply,
        (SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM ro_reason WHERE FIND_IN_SET(id, f.reason) > 0) as fallback_rules_fired,
        rr.name as resolution_name
    FROM forum_report_email_master f
    JOIN forum_report_email e ON f.id = e.report_ro_id
    LEFT JOIN system_user_master a ON f.fixed_by = a.sys_user_id
    LEFT JOIN newspaper_master n ON f.np_id = n.np_id
    LEFT JOIN ad_master am ON f.ad_id = am.ad_id
    LEFT JOIN status_master sm ON am.status = sm.id
    LEFT JOIN ro_reason rr ON rr.id = f.sub_reason
    LEFT JOIN new_categories nc ON am.category = nc.category_id
    WHERE f.generated_by = '6' AND f.id >= 283800 AND f.ad_id != 1944555 AND e.email LIKE 'Blocked by Editorial Checker%' AND (am.status IS NULL OR am.status != '1')
    ${timeCond}
    ORDER BY f.id DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `);

  return recent.map(r => {
    let extractedRules = '';
    if (r.explanation) {
      const emailText = String(r.explanation);
      if (emailText.includes('Blocked by Editorial Checker. Rules fired:') || emailText.includes('Update - Actual rules fired:')) {
        const lines = emailText.split(/\r?\n/).filter(l => l.trim().startsWith('- '));
        extractedRules = lines.map(l => {
          const content = l.trim().substring(2); // Remove "- "
          const parts = content.split(': ');
          if (parts.length > 1) {
            // Rule names might contain ": ", so we assume the last part is the explanation 
            // and everything before it is the rule name.
            return parts.slice(0, -1).join(': ');
          }
          return content;
        }).join('\n');
      }
    }

    const finalRulesFired = extractedRules || r.fallback_rules_fired || '-';

    return {
      id: r.id,
      ad_id: r.ad_id,
      status: String(r.status),
      reason: String(r.reason),
      reporting_time: (r.reporting_time && !isNaN(r.reporting_time.getTime())) ? r.reporting_time.toISOString() : '',
      fixed_time: (r.fixed_time && !isNaN(r.fixed_time.getTime())) ? r.fixed_time.toISOString() : null,
      fixed_by: r.fixed_by,
      feedback_comment: r.resolution_name || r.feedback_comment || '',
      admin_name: r.admin_name || 'Unknown',
      newspaper_name: r.newspaper_name,
      category_name: r.category_name || 'Unknown Category',
      explanation: r.explanation,
      ad_text: r.ad_text || '',
      ad_status: r.ad_status || '',
      cc_reply: r.cc_reply || '',
      rules_fired_names: finalRulesFired
    };
  });
}

export async function fetchRuleValidationStats(range: TimeRange = 'all'): Promise<RuleValidationStat[]> {
  const timeCond = getTimeCondition(range, 'm');
  const tickets = await queryRma<any>(`
    SELECT m.ad_id, m.status, rr.name as resolution_name 
    FROM forum_report_email_master m
    JOIN forum_report_email e ON m.id = e.report_ro_id
    LEFT JOIN ad_master am ON m.ad_id = am.ad_id
    LEFT JOIN ro_reason rr ON rr.id = IF(m.sub_reason != '', m.sub_reason, m.reason)
    WHERE m.generated_by = '6' AND m.id >= 283800 AND m.ad_id != 1944555 AND e.email LIKE 'Blocked by Editorial Checker%' AND (am.status IS NULL OR am.status != '1')
    ${timeCond}
  `);

  const alignments = await queryRmaAi<any>(`
    SELECT ad_id, our_rule_ids 
    FROM editorial_check_alignment
  `);

  const rules = await queryRmaAi<Rule>(`SELECT id, name FROM editorial_rule`);
  const ruleMap = new Map(rules.map(r => [r.id, r.name || `Rule #${r.id}`]));

  const adToRules = new Map<number, number[]>();
  for (const a of alignments) {
    if (a.our_rule_ids) {
      try {
        const parsed = JSON.parse(a.our_rule_ids);
        if (Array.isArray(parsed)) {
          adToRules.set(a.ad_id, parsed);
        }
      } catch (e) {}
    }
  }

  const ruleStats = new Map<number, RuleValidationStat>();
  
  for (const t of tickets) {
    const rulesForAd = adToRules.get(t.ad_id) || [];
    for (const ruleId of rulesForAd) {
      if (!ruleStats.has(ruleId)) {
        ruleStats.set(ruleId, {
          rule_id: ruleId,
          rule_name: ruleMap.get(ruleId) || `Rule #${ruleId}`,
          true_positives: 0,
          false_positives: 0,
          open_tickets: 0
        });
      }
      const rs = ruleStats.get(ruleId)!;
      const status = String(t.status);
      const feedback = String(t.resolution_name || '').toLowerCase().trim();
      
      if (status === '1') {
        rs.open_tickets += 1;
      } else if (status === '3' && feedback !== 'incorrectly reported') {
        rs.true_positives += 1;
      } else if (status === '3' && feedback === 'incorrectly reported') {
        rs.false_positives += 1;
      }
    }
  }

  return Array.from(ruleStats.values()).sort((a, b) => b.false_positives - a.false_positives);
}

export async function deleteTicket(id: number): Promise<boolean> {
  try {
    // Delete from child table first
    await executeRmaWrite(`DELETE FROM forum_report_email WHERE report_ro_id = ?`, [id]);
    // Then delete from master table
    await executeRmaWrite(`DELETE FROM forum_report_email_master WHERE id = ?`, [id]);
    return true;
  } catch (error) {
    console.error(`Failed to delete ticket ${id}:`, error);
    return false;
  }
}
