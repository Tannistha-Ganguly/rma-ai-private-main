// Unicode-range-based script detector. Not a full language identifier — we only
// need to know which script(s) dominate the text, which is what the rules engine
// uses for `language_only` checks (catching mojibake / wrong-script submissions).

const SCRIPT_RANGES: Array<{ name: string; ranges: Array<[number, number]> }> = [
  { name: 'Latin', ranges: [[0x0041, 0x024F]] },
  { name: 'Devanagari', ranges: [[0x0900, 0x097F]] }, // Hindi, Marathi, Sanskrit
  { name: 'Bengali', ranges: [[0x0980, 0x09FF]] },
  { name: 'Gurmukhi', ranges: [[0x0A00, 0x0A7F]] }, // Punjabi
  { name: 'Gujarati', ranges: [[0x0A80, 0x0AFF]] },
  { name: 'Oriya', ranges: [[0x0B00, 0x0B7F]] },
  { name: 'Tamil', ranges: [[0x0B80, 0x0BFF]] },
  { name: 'Telugu', ranges: [[0x0C00, 0x0C7F]] },
  { name: 'Kannada', ranges: [[0x0C80, 0x0CFF]] },
  { name: 'Malayalam', ranges: [[0x0D00, 0x0D7F]] },
  { name: 'Arabic', ranges: [[0x0600, 0x06FF]] }, // Urdu uses Arabic script
];

export interface ScriptProfile {
  dominant: string;
  counts: Record<string, number>;
  total_letters: number;
  question_mark_ratio: number; // mojibake indicator: bursts of '?' often mean broken Unicode
}

export function detectScript(text: string): ScriptProfile {
  const counts: Record<string, number> = {};
  let totalLetters = 0;
  let qmark = 0;
  let nonWhitespace = 0;

  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    nonWhitespace++;
    if (ch === '?') qmark++;
    const cp = ch.codePointAt(0)!;
    for (const s of SCRIPT_RANGES) {
      if (s.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) {
        counts[s.name] = (counts[s.name] ?? 0) + 1;
        totalLetters++;
        break;
      }
    }
  }

  let dominant = 'Unknown';
  let max = 0;
  for (const [name, n] of Object.entries(counts)) {
    if (n > max) {
      max = n;
      dominant = name;
    }
  }

  return {
    dominant,
    counts,
    total_letters: totalLetters,
    question_mark_ratio: nonWhitespace ? qmark / nonWhitespace : 0,
  };
}

// Heuristic: a burst of consecutive '?' characters strongly suggests mojibake
// (e.g. "??? ??????" from a broken Unicode submission).
export function looksLikeMojibake(text: string): boolean {
  const runs = text.match(/\?{3,}/g) ?? [];
  return runs.length >= 2;
}
