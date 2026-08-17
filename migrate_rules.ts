import 'dotenv/config';
import { executeRmaAi, queryRmaAi } from './src/lib/db/rmaAi';

async function run() {
  try {
    console.log('Adding new columns...');
    await executeRmaAi(`
      ALTER TABLE editorial_rule 
      ADD COLUMN hard_category_scope JSON NULL,
      ADD COLUMN hard_np_scope JSON NULL,
      ADD COLUMN soft_category_scope JSON NULL,
      ADD COLUMN soft_np_scope JSON NULL
    `);

    console.log('Migrating hard rules...');
    await executeRmaAi(`
      UPDATE editorial_rule 
      SET hard_category_scope = category_scope,
          hard_np_scope = np_scope
      WHERE severity = 'hard'
    `);

    console.log('Migrating soft rules...');
    await executeRmaAi(`
      UPDATE editorial_rule 
      SET soft_category_scope = category_scope,
          soft_np_scope = np_scope
      WHERE severity = 'soft'
    `);

    console.log('Migrating proposals...');
    const proposals = await queryRmaAi<any>(`SELECT id, proposed_payload FROM editorial_rule_proposal WHERE status = 'pending'`);
    for (const p of proposals) {
      if (typeof p.proposed_payload === 'string') {
        const parsed = JSON.parse(p.proposed_payload);
        if (parsed.severity === 'hard') {
          parsed.hard_category_scope = parsed.category_scope;
          parsed.hard_np_scope = parsed.np_scope;
        } else {
          parsed.soft_category_scope = parsed.category_scope;
          parsed.soft_np_scope = parsed.np_scope;
        }
        await executeRmaAi(`UPDATE editorial_rule_proposal SET proposed_payload = ? WHERE id = ?`, [JSON.stringify(parsed), p.id]);
      }
    }

    console.log('Migration complete!');
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  }
}

run();
