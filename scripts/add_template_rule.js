require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function addTemplateRule() {
  const pool = mysql.createPool({
    host: process.env.RMA_AI_DB_HOST,
    user: process.env.RMA_AI_DB_USER,
    password: process.env.RMA_AI_DB_PASS,
    database: process.env.RMA_AI_DB_NAME,
  });

  try {
    const insertQuery = `
      INSERT INTO editorial_rule (
        name,
        description,
        customer_message,
        rule_type,
        pattern,
        category_scope,
        severity,
        source,
        status,
        target_ro_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      "Unfilled Template Placeholders",
      "Detects if the user has submitted a raw template without filling in their details.",
      "Please fill in all the template placeholders (e.g., replace '(Old Name)' with your actual name) before submitting the ad.",
      "regex_ban",
      JSON.stringify({ regex: "\\\\([^\\\\)]+\\\\)|\\\\[[^\\]]+\\\\]|XXXX|<[^>]+>" }),
      JSON.stringify([]), // applies to all categories
      "soft",
      "team_added",
      "active",
      JSON.stringify([207]) // maps to Reason 207: Verify Ad Content (Incomplete Ad)
    ];

    const [result] = await pool.execute(insertQuery, values);
    console.log("Successfully added 'Unfilled Template Placeholders' rule! ID:", result.insertId);

  } catch (error) {
    console.error("Error adding template rule:", error);
  } finally {
    await pool.end();
  }
}

addTemplateRule();
