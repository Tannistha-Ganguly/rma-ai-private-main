import OpenAI from 'openai';
import { fetchAndParseDocument } from './documentParser';
import type { Finding, Rule } from './types';

export interface Pass4Result {
  waived_rule_ids: number[];
  cost_paise: number;
}

const SYSTEM_PROMPT = `You are a strict editorial compliance auditor. 
Your job is to examine an uploaded document (PDF text or Image) and determine if it satisfies the missing document requirements flagged for a specific classified advertisement.

You will be given:
1. The Ad Text.
2. The Rules that flagged the ad for requiring documents (e.g. Affidavit, Letterhead, Photo ID).
3. The contents of the attached Document.

If the document clearly satisfies the requirements of a flagged rule, output the rule_id in the \`waived_rule_ids\` array.
If the document is illegible, irrelevant, or does not satisfy the rule, DO NOT include the rule_id.

Output strictly valid JSON with no markdown wrapping.
Format:
{
  "reasoning": "Explain step-by-step why the document satisfies or fails each rule.",
  "waived_rule_ids": [123, 456]
}
`;

export async function runPass4(
  client: any,
  adText: string,
  documentUrl: string,
  findings: Finding[],
  rules: Rule[]
): Promise<Pass4Result> {
  const result: Pass4Result = { waived_rule_ids: [], cost_paise: 0 };

  // 1. Identify which findings require documents
  const docRuleIds = new Set<number>();
  for (const f of findings) {
    const r = rules.find((rule) => rule.id === f.rule_id);
    if (r) {
      const isDocReason = r.target_ro_reason?.includes(6);
      const nameMatch = /(document|proof|photo id|letterhead|affidavit)/i.test(r.name);
      const descMatch = /(document|proof|photo id|letterhead|affidavit)/i.test(r.description);
      if (isDocReason || nameMatch || descMatch) {
        docRuleIds.add(f.rule_id);
      }
    }
  }

  if (docRuleIds.size === 0) return result;

  // 2. Fetch and parse document
  const parsedDoc = await fetchAndParseDocument(documentUrl);
  if (!parsedDoc) return result;

  // 3. Prepare rules context
  const rulesContext = Array.from(docRuleIds).map((id) => {
    const r = rules.find((rule) => rule.id === id)!;
    return `Rule ID: ${r.id}\nName: ${r.name}\nDescription: ${r.description}`;
  }).join('\n\n');

  const contentStr = `<ad_text>${adText}</ad_text>\n<flagged_rules>\n${rulesContext}\n</flagged_rules>\n`;

  let anthropicContent: any[] = [];
  let openaiContent: any[] = [];

  if (parsedDoc.type === 'document') {
    anthropicContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: parsedDoc.media_type, data: parsedDoc.data }
      },
      { type: 'text', text: contentStr }
    ];
    // OpenAI fallback might not support base64 PDFs natively in chat, we just pass text
    openaiContent = [{ type: 'text', text: contentStr + '\n[Document analysis via PDF is unsupported in fallback]' }];
  } else if (parsedDoc.type === 'image') {
    anthropicContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: parsedDoc.media_type, data: parsedDoc.data }
      },
      { type: 'text', text: contentStr }
    ];
    openaiContent = [
      {
        type: 'image_url',
        image_url: { url: `data:${parsedDoc.media_type};base64,${parsedDoc.data}` }
      },
      { type: 'text', text: contentStr }
    ];
  }

  let raw = '';
  let useFallback = false;

  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: anthropicContent }],
        temperature: 0.1,
      });
      raw = response.content[0].text;
      const inTok = response.usage?.input_tokens ?? 0;
      const outTok = response.usage?.output_tokens ?? 0;
      result.cost_paise = Math.ceil(((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500) * 84);
    } catch (e) {
      console.warn("Anthropic API failed in pass4, falling back to Nvidia API", e);
      useFallback = true;
    }
  } else {
    useFallback = true;
  }

  if (useFallback) {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      console.error('NVIDIA_API_KEY is missing');
      return result;
    }
    const openai = new OpenAI({
      apiKey,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });

    try {
      const completion = await openai.chat.completions.create({
        model: 'meta/llama-3.2-90b-vision-instruct',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: openaiContent }
        ],
        temperature: 0.1,
      });

      console.log('PASS 4 RAW OUTPUT:', completion.choices[0]?.message?.content);

      const inTok = completion.usage?.prompt_tokens ?? 0;
      const outTok = completion.usage?.completion_tokens ?? 0;
      const costUsdCents = (inTok / 1_000_000) * 70 + (outTok / 1_000_000) * 90;
      result.cost_paise = Math.ceil(costUsdCents * 84);

      raw = (completion.choices[0].message.content ?? '').trim();
    } catch (err) {
      console.error('Pass 4 Nvidia API Error:', err);
      return result;
    }
  }

  try {
    raw = raw.trim();
    if (raw.startsWith('```json')) raw = raw.slice(7, -3).trim();

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.waived_rule_ids)) {
      result.waived_rule_ids = parsed.waived_rule_ids.filter((id: any) => typeof id === 'number');
    }
  } catch (err) {
    console.error('Pass 4 LLM Error:', err);
  }

  return result;
}
