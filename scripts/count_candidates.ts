import 'dotenv/config';
import { queryRma } from '../src/lib/db/rma';
import { queryRmaAi } from '../src/lib/db/rmaAi';

async function run() {
  try {
    const candidates = await queryRma<{ ad_id: number }>(`
      SELECT am.ad_id
      FROM ad_master am
      WHERE CHAR_LENGTH(am.ad_text) > 0
        AND am.status = 12
        AND am.ad_text NOT LIKE 'http%'
        AND am.ad_text NOT LIKE '%s3.amazonaws.com%'
        AND LOWER(TRIM(am.ad_text)) != 'pdf'
    `);
    
    console.log('Total candidates with status=12:', candidates.length);

    const candidateIds = candidates.map(c => c.ad_id);
    
    if (candidateIds.length > 0) {
      const shadowed = await queryRmaAi<{ ad_id: number }>(
        `SELECT DISTINCT ad_id FROM editorial_check_run WHERE run_mode = 'shadow' AND ad_id IN (${candidateIds.join(',')})`,
      );
      console.log('Of those 84 candidates, how many are ALREADY shadowed?', shadowed.length);
    }

  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}

run();
