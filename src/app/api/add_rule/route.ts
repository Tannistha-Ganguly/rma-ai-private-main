import { NextResponse } from 'next/server';
import { executeRmaAi } from '@/lib/db/rmaAi';

export async function GET() {
  try {
    // Fix Rule 2
    await executeRmaAi(`
      UPDATE editorial_rule 
      SET rule_type = 'llm_semantic',
          pattern = ?
      WHERE id = 2
    `, [
      JSON.stringify({
        check_prompt: "Does this Lost & Found ad include a way to contact the person who placed the ad? Look for any valid phone number, mobile number, email address, or physical address where the item can be returned. Return true ONLY if absolutely no contact information is provided at all."
      })
    ]);

    // Fix Rule 207
    await executeRmaAi(`
      UPDATE editorial_rule 
      SET rule_type = 'llm_semantic',
          pattern = ?
      WHERE id = 207
    `, [
      JSON.stringify({
        check_prompt: "Scan the ad specifically for phone numbers or mobile numbers. If you find one, does it appear to be an invalid format? Valid formats include 10-digit Indian numbers, or international numbers starting with a country code (e.g., +1, +44). CRITICAL: Do NOT flag dates, pincodes, registration numbers, or IDs as invalid phone numbers. Return true ONLY if you find an explicitly labeled phone number that is clearly missing digits or formatted incorrectly."
      })
    ]);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
