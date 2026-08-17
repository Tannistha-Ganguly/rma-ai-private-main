require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const pool = mysql.createPool({
    host: process.env.RMA_AI_DB_HOST,
    user: process.env.RMA_AI_DB_USER,
    password: process.env.RMA_AI_DB_PASSWORD,
    database: process.env.RMA_AI_DB_NAME,
    port: Number(process.env.RMA_AI_DB_PORT),
  });
  
  const result = await pool.execute(`
    INSERT INTO editorial_rule (name, description, customer_message, rule_type, pattern, severity, source, status, target_ro_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'Unfilled Template Placeholders',
    'Ad text contains literal template placeholders that the user forgot to fill in, such as (Old Name), (Fathers Name), (Date of Birth), [Date], [Insert Name Here], XXXX. These placeholders indicate the ad is incomplete.',
    'Please replace all template placeholders with the actual information.',
    'regex_ban',
    JSON.stringify({
      regex: "\\\\([A-Za-z ]+\\\\)|\\[[A-Za-z ]+\\]|XXXX",
      flags: "gi"
    }),
    'hard',
    'team_added',
    'active',
    JSON.stringify([207])
  ]);
  console.log('Done:', result);
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
