import OpenAI from 'openai';
import type { CheckInput, CategoryChoice, Finding } from './types';

export interface CategoryCandidate {
  category_id: number;
  category_name: string;
  parent_cat_id: number;
}

export interface Pass2Result {
  is_correct: boolean;
  suggested_category?: CategoryChoice;
  reasoning: string;
  cost_paise: number;
  finding?: Finding;
}

const SYSTEM_PROMPT = `You are evaluating whether a newspaper-ad customer's chosen ad category matches the actual content of their ad text.

The platform is releaseMyAd (RMA). Ads can be in English, Hindi, Bengali, Tamil, Telugu, Malayalam, Gujarati, Punjabi, Kannada, Marathi, or Urdu.

Return STRICT JSON only — no prose, no markdown:
{
  "is_correct": boolean,
  "suggested_category_id": number | null,
  "reasoning": "short explanation (≤200 chars)"
}`;

function buildUserPrompt(input: CheckInput, chosen: CategoryCandidate | null, candidates: CategoryCandidate[]): string {
  const candList = candidates
    .slice(0, 30) // cap for token cost
    .map((c) => `  - id=${c.category_id}: ${c.category_name}`)
    .join('\n');
  return `Ad text:
"""
${input.ad_text}
"""

Customer chose:
${chosen ? `  id=${chosen.category_id}: ${chosen.category_name} (parent=${chosen.parent_cat_id})` : '(not provided)'}

Plausible alternative categories:
${candList}

Is the chosen category correct for this ad text? If not, which id from the list above is the best fit?`;
}

export async function runPass2(
  client: any,
  input: CheckInput,
  chosen: CategoryCandidate | null,
  candidates: CategoryCandidate[],
): Promise<Pass2Result> {
  let raw = '';
  let costPaise = 0;
  let useFallback = false;

  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(input, chosen, candidates) }],
        temperature: 0.1,
      });
      raw = response.content[0].text;
      const inTok = response.usage?.input_tokens ?? 0;
      const outTok = response.usage?.output_tokens ?? 0;
      costPaise = Math.ceil(((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500) * 84);
    } catch (e) {
      console.warn("Anthropic API failed in pass2, falling back to Nvidia API", e);
      useFallback = true;
    }
  } else {
    useFallback = true;
  }

  if (useFallback) {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      console.error('NVIDIA_API_KEY is missing');
      return { is_correct: true, reasoning: 'Fallback missing API key', cost_paise: 0 };
    }
    const openai = new OpenAI({
      apiKey,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });

    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      max_tokens: 256,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input, chosen, candidates) }
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
  const parsed = JSON.parse(raw) as { is_correct: boolean; suggested_category_id: number | null; reasoning: string };

  if (parsed.is_correct) {
    return { is_correct: true, reasoning: parsed.reasoning, cost_paise: costPaise };
  }

  return {
    is_correct: false,
    suggested_category: parsed.suggested_category_id ? { top: parsed.suggested_category_id } : undefined,
    reasoning: parsed.reasoning,
    cost_paise: costPaise,
    finding: {
      rule_id: -1, // synthetic — sourced from pass2, not a stored rule
      rule_name: 'Category match (pass-2)',
      severity: 'soft',
      score: 0.5,
      confidence: 1.0,
      message: parsed.suggested_category_id
        ? `Your ad text looks closer to a different category. Suggested: ${parsed.suggested_category_id}. ${parsed.reasoning}`
        : `The chosen category may not fit this ad. ${parsed.reasoning}`,
    },
  };
}
