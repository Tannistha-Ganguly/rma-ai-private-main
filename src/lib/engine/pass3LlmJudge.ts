import OpenAI from 'openai';
import { type Rule, type Finding, type CheckInput } from './types';
import { applies } from './pass1Rules';

export interface Pass3Context {
  cat_mes_advisories: string[]; // raw HTML-stripped messages for this (category, np) combo
  pass1_findings: Finding[];     // what the deterministic engine already caught
  semantic_rules: Rule[];        // rules with rule_type='llm_semantic' that apply
}

export interface Pass3Result {
  findings: Finding[];
  cost_paise: number;
}

const SYSTEM_PROMPT = `You are an editorial reviewer for releaseMyAd, India's largest online newspaper-ad booking platform. You evaluate ad text against a list of editorial rules. Rules can be in English; ad text can be in any Indian language.

Evaluate the ad against each provided rule. ONLY return a finding if the ad VIOLATES the text rule, OR if the rule explicitly states it is a document upload requirement (since documents are validated in a later pass).
If the ad complies with a text rule, do NOT return a finding.

Return STRICT JSON only — no prose, no markdown:
{
  "findings": [
    {
      "rule_id": number,
      "severity": "hard" | "soft",
      "confidence": number, // float between 0.0 and 1.0 (e.g., 0.95)
      "message": "what the customer should fix (≤200 chars, in English)"
    }
  ]
}`;

function buildUserPrompt(input: CheckInput, ctx: Pass3Context): string {
  const rulesBlock = ctx.semantic_rules
    .map((r) => {
      const pattern = r.pattern as { check_prompt?: string; examples?: any[] };
      const checkPrompt = pattern.check_prompt ?? r.description;
      let exampleText = '';
      if (pattern.examples && pattern.examples.length > 0) {
        exampleText = '\n  Examples:\n' + pattern.examples.map(e =>
          `    - Text: "${e.text}"\n      Violation: ${e.is_violation ? 'YES' : 'NO'}\n      Reasoning: ${e.reasoning}`
        ).join('\n');
      }
      return `Rule id=${r.id}: ${r.name}
  Description: ${r.description}
  Check: ${checkPrompt}${exampleText}`;
    })
    .join('\n\n');

  const advisoriesBlock = ctx.cat_mes_advisories.slice(0, 6).map((a, i) => `${i + 1}. ${a}`).join('\n');

  return `Ad text:
"""
${input.ad_text}
"""

Customer's chosen category: ${JSON.stringify(input.category_chosen)}
${input.np_id ? `Newspaper id: ${input.np_id}` : ''}

Pass-1 deterministic findings (for context — do not duplicate):
${ctx.pass1_findings.length ? ctx.pass1_findings.map((f) => `- ${f.rule_name}: ${f.message}`).join('\n') : '(none)'}

Editorial advisories for this category/newspaper (for context):
${advisoriesBlock || '(none specifically catalogued)'}

Semantic rules to evaluate:
${rulesBlock || '(none — return empty findings)'}`;
}

export async function runPass3(client: any, input: CheckInput, ctx: Pass3Context): Promise<Pass3Result> {
  if (ctx.semantic_rules.length === 0) return { findings: [], cost_paise: 0 };

  let raw = '';
  let costPaise = 0;
  let useFallback = false;

  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(input, ctx) }],
        temperature: 0.1,
      });
      raw = response.content[0].text;
      const inTok = response.usage?.input_tokens ?? 0;
      const outTok = response.usage?.output_tokens ?? 0;
      costPaise = Math.ceil(((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500) * 84);
    } catch (e) {
      console.warn("Anthropic API failed in pass3, falling back to Nvidia API", e);
      useFallback = true;
    }
  } else {
    useFallback = true;
  }

  if (useFallback) {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      console.error('NVIDIA_API_KEY is missing');
      return { findings: [], cost_paise: 0 };
    }
    const openai = new OpenAI({
      apiKey,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });

    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input, ctx) }
      ],
      temperature: 0.1,
    });

    const inTok = completion.usage?.prompt_tokens ?? 0;
    const outTok = completion.usage?.completion_tokens ?? 0;
    const costUsdCents = (inTok / 1_000_000) * 70 + (outTok / 1_000_000) * 90;
    costPaise = Math.ceil(costUsdCents * 84);
    raw = (completion.choices[0].message.content ?? '').trim();
  }

  raw = raw.trim();
  
  if (raw.startsWith('```')) {
    raw = raw.split('\n').slice(1, -1).join('\n');
  }
  
  console.log("LLM Raw Output:", raw);
  let parsed: { findings: any[] } = { findings: [] };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      parsed = JSON.parse(raw);
    }
  } catch (e: any) {
    console.error("[Pass 3 JSON Error]", e.message, "Falling back to regex extraction for:", raw);
    // Fallback: extract rule_id, severity, and message using regex if JSON is truncated
    let findingsList: any[] = [];
    const blocks = raw.split(/\{/).slice(1);
    for (const block of blocks) {
      const rMatch = block.match(/"rule_id"\s*:\s*(\d+)/);
      const sMatch = block.match(/"severity"\s*:\s*"([^"]+)"/);
      const cMatch = block.match(/"confidence"\s*:\s*([\d.]+)/);
      const mMatch = block.match(/"message"\s*:\s*"([^"]+)"/);
      if (rMatch && sMatch && mMatch) {
        findingsList.push({
          rule_id: parseInt(rMatch[1], 10),
          severity: sMatch[1],
          confidence: cMatch ? parseFloat(cMatch[1]) : 1.0,
          message: mMatch[1]
        });
      }
    }
    parsed = { findings: findingsList };
  }

  let findings: Finding[] = (parsed.findings || []).map((f: any) => {
    const rule = ctx.semantic_rules.find((r) => r.id === f.rule_id);
    let conf = typeof f.confidence === 'number' ? f.confidence : 1.0;
    if (conf > 1.0) conf = conf / 100.0; // protect against LLM returning percentages (e.g., 95 instead of 0.95)
    
    const dynSeverity = rule ? applies(rule, input) || f.severity : f.severity;
    const base = rule?.base_score ?? (dynSeverity === 'hard' ? 1.0 : 0.5);
    return {
      rule_id: f.rule_id,
      rule_name: rule?.name ?? `LLM-rule-${f.rule_id}`,
      severity: dynSeverity,
      score: base * conf,
      confidence: conf,
      message: f.message,
    };
  });

  // If the Universal Category Mismatch rule (ID 326) fires, discard all other findings.
  const categoryMismatchFinding = findings.find(f => f.rule_id === 326);
  if (categoryMismatchFinding) {
    findings = [categoryMismatchFinding];
  }

  return { findings, cost_paise: costPaise };
}

