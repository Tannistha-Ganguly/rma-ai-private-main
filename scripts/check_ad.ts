import 'dotenv/config';
import { queryRma } from '../src/lib/db/rma';

async function run() {
  try {
    const res = await queryRma('SELECT status FROM ad_master WHERE ad_id = 1943326');
    console.log('Ad 1943326 status:', res);
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
run();
