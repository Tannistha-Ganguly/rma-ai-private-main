import 'dotenv/config';
import { queryRma } from '../src/lib/db/rma';

async function run() {
  try {
    const res = await queryRma('SELECT * FROM status_master');
    console.log('Statuses:', res);
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}

run();
