import 'dotenv/config';
import { queryRma } from '../src/lib/db/rma';
import { queryRmaAi } from '../src/lib/db/rmaAi';

async function run() {
  try {
    console.log('Fetching all ad IDs from shadow runs...');
    const runs = await queryRmaAi<{ id: number, ad_id: number }>('SELECT id, ad_id FROM editorial_check_run WHERE run_mode = "shadow"');
    
    console.log(`Found ${runs.length} shadow runs. Checking their statuses in RMA DB...`);
    
    let deletedCount = 0;
    
    // Check in batches or just do one big query
    const adIds = runs.map(r => r.ad_id);
    if (adIds.length > 0) {
      const statuses = await queryRma<{ ad_id: number, status: string }>(
        `SELECT ad_id, status FROM ad_master WHERE ad_id IN (${adIds.join(',')})`
      );
      
      const toDelete = statuses.filter(s => s.status === '1' || s.status === '5').map(s => s.ad_id);
      
      if (toDelete.length > 0) {
        console.log(`Found ${toDelete.length} ads with status 1 or 5. Deleting them from RMA AI DB...`);
        
        // Deleting from editorial_check_run should ideally cascade to editorial_check_alignment,
        // but we can delete from both just to be safe.
        await queryRmaAi(`DELETE FROM editorial_check_alignment WHERE ad_id IN (${toDelete.join(',')})`);
        await queryRmaAi(`DELETE FROM editorial_check_run WHERE run_mode = 'shadow' AND ad_id IN (${toDelete.join(',')})`);
        
        deletedCount = toDelete.length;
      }
    }
    
    console.log(`Cleanup complete. Deleted ${deletedCount} ads.`);

  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}

run();
