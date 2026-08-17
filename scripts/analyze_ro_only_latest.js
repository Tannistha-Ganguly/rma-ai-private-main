require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function analyze() {
  const pool = mysql.createPool({
    host: process.env.RMA_AI_DB_HOST,
    user: process.env.RMA_AI_DB_USER,
    password: process.env.RMA_AI_DB_PASS,
    database: process.env.RMA_AI_DB_NAME,
  });

  try {
    const [runs] = await pool.query("SELECT id FROM editorial_check_run WHERE run_mode='backtest' ORDER BY id DESC LIMIT 1");
    if (runs.length === 0) return;
    const runId = runs[0].id;

    const [outcomes] = await pool.query(`
      SELECT outcome, count(*) as count
      FROM editorial_check_alignment 
      WHERE check_run_id = ?
      GROUP BY outcome
    `, [runId]);

    console.log(`Run ID: ${runId}`);
    console.table(outcomes);
  } finally {
    await pool.end();
  }
}

analyze();
