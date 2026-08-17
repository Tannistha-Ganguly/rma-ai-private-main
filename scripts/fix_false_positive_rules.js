const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function fixRules() {
  const pool = mysql.createPool({
    host: process.env.RMA_AI_DB_HOST,
    user: process.env.RMA_AI_DB_USER,
    password: process.env.RMA_AI_DB_PASS,
    database: process.env.RMA_AI_DB_NAME,
  });

  try {
    // Fix Rule 2
    await pool.execute(`
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
    await pool.execute(`
      UPDATE editorial_rule 
      SET rule_type = 'llm_semantic',
          pattern = ?
      WHERE id = 207
    `, [
      JSON.stringify({
        check_prompt: "Scan the ad specifically for phone numbers or mobile numbers. If you find one, does it appear to be an invalid format? Valid formats include 10-digit Indian numbers, or international numbers starting with a country code (e.g., +1, +44). CRITICAL: Do NOT flag dates, pincodes, registration numbers, or IDs as invalid phone numbers. Return true ONLY if you find an explicitly labeled phone number that is clearly missing digits or formatted incorrectly."
      })
    ]);

    console.log("Successfully updated Rule 2 and Rule 207 to LLM Semantic rules.");
  } catch (error) {
    console.error("Error updating rules:", error);
  } finally {
    await pool.end();
  }
}

fixRules();
