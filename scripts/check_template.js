require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function check() {
  const pool = mysql.createPool({
    host: process.env.RMA_AI_DB_HOST,
    user: process.env.RMA_AI_DB_USER,
    password: process.env.RMA_AI_DB_PASS,
    database: process.env.RMA_AI_DB_NAME,
  });

  try {
    const [rows] = await pool.query("SELECT id, name FROM editorial_rule WHERE name LIKE '%Template%' OR name LIKE '%Placeholders%'");
    console.log("Template Rules found:");
    console.table(rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

check();
